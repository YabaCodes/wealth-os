import test from "node:test";
import assert from "node:assert/strict";
import { goalWhatIfFor } from "../js/wealth-view-model.js";

const referenceDate = new Date(2026, 9, 18);
const goals = [
  { id: "goal-emergency", name: "Emergency Fund", bucketId: "emergency",
    targetAmount: 300000, status: "active", priority: 1 },
  { id: "goal-home-trip", name: "Home Travel", bucketId: "home-trip",
    targetAmount: 100000, status: "waiting", priority: 2,
    prerequisiteGoalId: "goal-emergency", prerequisiteAmount: 200000 },
  { id: "goal-equipment", name: "Equipment", bucketId: "equipment",
    targetAmount: 40000, status: "paused", priority: 3 },
];

const history = [
  { id: "2026-08" }, { id: "2026-09" }, { id: "2026-10" },
];
const completed = (periodId, bucketId) =>
  bucketId === "emergency" ? { "2026-08": 6000, "2026-09": 4000, "2026-10": 5000 }[periodId] || 0 : 0;
const args = (goal = goals[0], balances = { emergency: 195000 }, extra = 10000) => ({
  goal, goals, bucketBalances: balances, recentHistory: history,
  completedAllocation: completed, extraMonthly: extra, referenceDate,
});

test("what-if uses recorded goal funding, not total bank balances or hypothetical planned routing", () => {
  const projection = goalWhatIfFor(args());
  assert.equal(projection.status, "active");
  assert.equal(projection.balance, 195000);
  assert.equal(projection.remaining, 105000);
  assert.equal(projection.baseMonthly, 5000);
  assert.equal(projection.extraMonthly, 10000);
  assert.equal(projection.scenarioMonthly, 15000);
  assert.equal(projection.baseMonths, 21);
  assert.equal(projection.scenarioMonths, 7);
  assert.equal(projection.baseDate, "Jul 2028");
  assert.equal(projection.scenarioDate, "May 2027");
  assert.equal(projection.monthsSaved, 14);
});

test("zero actual contribution still allows clearly hypothetical extra to be illustrated", () => {
  const simulation = goalWhatIfFor({
    ...args(), recentHistory: [],
  });
  assert.equal(simulation.baseMonthly, 0);
  assert.equal(simulation.baseDate, null);
  assert.equal(simulation.scenarioMonths, 11);
  assert.equal(simulation.scenarioDate, "Sep 2027");
  assert.equal(simulation.monthsSaved, null);
  const none = goalWhatIfFor({
    ...args(), recentHistory: [], extraMonthly: 0,
  });
  assert.equal(none.scenarioDate, null);
  assert.equal(none.baseDate, null);
});

test("waiting and paused goals never show an actionable completion forecast", () => {
  const waiting = goalWhatIfFor(args(goals[1], { emergency: 195000, "home-trip": 2000 }, 10000));
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.remaining, 98000);
  assert.equal(waiting.baseDate, null);
  assert.equal(waiting.scenarioDate, null);
  const paused = goalWhatIfFor(args(goals[2], { equipment: 2000 }, 20000));
  assert.equal(paused.status, "paused");
  assert.equal(paused.scenarioDate, null);
  const unlocked = goalWhatIfFor(args(goals[1], { emergency: 200000, "home-trip": 2000 }, 10000));
  assert.equal(unlocked.status, "active");
  assert.equal(unlocked.scenarioMonths, 10);
});

test("completed goals stay complete regardless of extra input or pause setting", () => {
  const completedGoal = goalWhatIfFor(args(goals[2], { equipment: 45000 }, 30000));
  assert.equal(completedGoal.status, "complete");
  assert.equal(completedGoal.remaining, 0);
  assert.equal(completedGoal.scenarioDate, null);
  assert.equal(completedGoal.monthsSaved, null);
});

test("empty target, negative, malformed and excessive extra contributions are safe", () => {
  const noTarget = goalWhatIfFor(args({
    id: "no-target", bucketId: "emergency", targetAmount: 0, status: "active",
  }));
  assert.equal(noTarget.scenarioDate, null);
  assert.equal(goalWhatIfFor(args(goals[0], { emergency: 195000 }, -500)).extraMonthly, 0);
  assert.equal(goalWhatIfFor(args(goals[0], { emergency: 195000 }, "oops")).extraMonthly, 0);
  assert.equal(goalWhatIfFor(args(goals[0], { emergency: 195000 }, Infinity)).extraMonthly, 0);
  assert.equal(goalWhatIfFor(args(goals[0], { emergency: 195000 }, 50000000)).extraMonthly, 1000000);
  assert.equal(goalWhatIfFor({ goal: null }), null);
});

test("the scenario never mutates goals, balances, history or recorded allocations", () => {
  const balances = { emergency: 195000, "home-trip": 1000, equipment: 2000 };
  const before = structuredClone({ goals, balances, history });
  const simulated = goalWhatIfFor(args(goals[0], balances, 35000));
  assert.ok(simulated.monthsSaved > 0);
  assert.deepEqual({ goals, balances, history }, before);
});
