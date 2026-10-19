import test from "node:test";
import assert from "node:assert/strict";
import { goalsPortfolioFor } from "../js/wealth-view-model.js";

const referenceDate = new Date(2026, 9, 19);
const goals = [
  { id: "em", name: "Emergency Fund", priority: 1, bucketId: "emergency",
    targetAmount: 300000, targetDate: "2027-03-31", status: "active" },
  { id: "trip", name: "Home Travel", priority: 2, bucketId: "travel",
    targetAmount: 100000, targetDate: "2027-04-30", status: "active",
    prerequisiteGoalId: "em", prerequisiteAmount: 200000 },
  { id: "equipment", name: "Equipment", priority: 3, bucketId: "equipment",
    targetAmount: 40000, targetDate: "2027-08-31", status: "paused" },
  { id: "bike", name: "Cycling Goal", priority: 4, bucketId: "bike",
    targetAmount: 60000, targetDate: "2027-06-30", status: "active" },
];
const history = [{ id: "2026-08" }, { id: "2026-09" }, { id: "2026-10" }];
const contributions = { emergency: [3000, 5000, 7000], travel: [0, 0, 0],
  equipment: [0, 0, 0], bike: [0, 0, 0] };
const allocation = (month, bucket) => (contributions[bucket] || [0, 0, 0])[
  history.findIndex((h) => h.id === month)] || 0;
const args = (overrides = {}) => ({
  goals, bucketBalances: { emergency: 195000, travel: 2000, equipment: 0, bike: 0 },
  recentHistory: history, completedAllocation: allocation,
  monthlyCapacity: 26000, referenceDate, ...overrides,
});

test("portfolio chooses highest priority ACTIVE goal and respects prereqs, paused goals", () => {
  const p = goalsPortfolioFor(args());
  assert.equal(p.focus.id, "em");
  assert.deepEqual(p.rows.map((r) => r.id), ["em", "trip", "equipment", "bike"]);
  assert.equal(p.rows[0].health, "behind");
  assert.equal(p.rows[0].requiredMonthly, 21000);
  assert.equal(p.rows[0].recordedMonthly, 5000);
  assert.equal(p.rows[1].health, "waiting");
  assert.equal(p.rows[1].requiredMonthly, null);
  assert.equal(p.rows[2].health, "paused");
  assert.equal(p.rows[2].requiredMonthly, null);
  assert.equal(p.rows[3].health, "no-history");
  assert.equal(p.rows[3].requiredMonthly, 7500);
});

test("shared plan combines ALL active deadline requirements once, never awards full capacity to each", () => {
  const p = goalsPortfolioFor(args());
  assert.deepEqual(p.shared, {
    capacity: 26000, requiredTotal: 28500, coveredGoals: 2,
    activeGoals: 2, missingDeadline: 0, gap: 2500, state: "above-plan",
  });
  const enough = goalsPortfolioFor(args({ monthlyCapacity: 30000 }));
  assert.equal(enough.shared.state, "within-plan");
  assert.equal(enough.shared.gap, 0);
  assert.equal(enough.shared.requiredTotal, 28500);
  const unknown = goalsPortfolioFor(args({ monthlyCapacity: null }));
  assert.equal(unknown.shared.state, "unknown");
  assert.equal(unknown.shared.gap, null);
});

test("undated active goal prevents a portfolio-wide affordability claim", () => {
  const undated = goals.map((g) => g.id === "bike" ? { ...g, targetDate: null } : g);
  const p = goalsPortfolioFor(args({ goals: undated, monthlyCapacity: 30000 }));
  assert.equal(p.shared.state, "partial");
  assert.equal(p.shared.missingDeadline, 1);
  assert.equal(p.shared.requiredTotal, 21000);
  assert.equal(p.rows.find((r) => r.id === "bike").health, "no-deadline");
  const noDates = goals.map((g) => ({ ...g, targetDate: null }));
  assert.equal(goalsPortfolioFor(args({ goals: noDates })).shared.state, "no-deadlines");
});

test("statuses, completed targets, pace and expired deadlines produce non-actionable health", () => {
  const withFunds = goalsPortfolioFor(args({
    bucketBalances: { emergency: 300000, travel: 100000, equipment: 40000, bike: 0 },
  }));
  assert.equal(withFunds.rows[0].health, "complete");
  assert.equal(withFunds.rows[1].health, "complete");
  assert.equal(withFunds.rows[2].health, "complete");
  assert.equal(withFunds.focus.id, "bike");
  const withPace = goalsPortfolioFor(args({
    completedAllocation: (periodId, bucket) => bucket === "emergency" ? 25000 : allocation(periodId, bucket),
  }));
  assert.equal(withPace.rows[0].health, "at-pace");
  const expired = goalsPortfolioFor(args({
    goals: goals.map((g) => g.id === "em" ? { ...g, targetDate: "2026-10-31" } : g),
  }));
  assert.equal(expired.rows[0].health, "needs-review");
  assert.equal(expired.rows[0].requiredMonthly, null);
});

test("goal statuses and amount filtering are stable with archived and blank goal entries", () => {
  const noGoals = goalsPortfolioFor(args({ goals: [] }));
  assert.deepEqual(noGoals.rows, []);
  assert.equal(noGoals.focus, null);
  const x = goalsPortfolioFor(args({ goals: [
    { id: "archived", priority: 0, status: "archived", bucketId: "z", targetAmount: 1000 },
    { id: "waiting", name: "Waiting", status: "active", bucketId: "w", priority: 2,
      targetAmount: 1000, prerequisiteGoalId: "em", prerequisiteAmount: 250000 },
    goals[0],
  ] }));
  assert.equal(x.rows.length, 2);
  assert.equal(x.focus.id, "em");
});

test("only read-only input snapshots are used; portfolio calculations never change goal data", () => {
  const input = args();
  const original = structuredClone({ goals: input.goals, bucketBalances: input.bucketBalances, history });
  const a = goalsPortfolioFor(input), b = goalsPortfolioFor(input);
  assert.deepEqual(a, b);
  assert.deepEqual({ goals: input.goals, bucketBalances: input.bucketBalances, history }, original);
});
