import test from "node:test";
import assert from "node:assert/strict";
import { goalTargetDateFor } from "../js/wealth-view-model.js";

const referenceDate = new Date(2026, 9, 19);
const goals = [
  { id: "goal-emergency", bucketId: "emergency", targetAmount: 300000, status: "active" },
  { id: "goal-home-trip", bucketId: "home-trip", targetAmount: 100000, status: "active",
    prerequisiteGoalId: "goal-emergency", prerequisiteAmount: 200000 },
  { id: "goal-equipment", bucketId: "equipment", targetAmount: 40000, status: "paused" },
];
const history = [{ id: "2026-08" }, { id: "2026-09" }, { id: "2026-10" }];
const completedAllocation = (id, bucket) => bucket === "emergency"
  ? { "2026-08": 6000, "2026-09": 4000, "2026-10": 5000 }[id] : 0;
const args = (overrides = {}) => ({
  goal: goals[0], goals, bucketBalances: { emergency: 195000 },
  recentHistory: history, completedAllocation,
  deadline: "2027-03-31", monthlyCapacity: 20000, referenceDate,
  ...overrides,
});

test("a March month-end deadline counts five next-month deposits, rounding monthly required up", () => {
  const x = goalTargetDateFor(args());
  assert.equal(x.remaining, 105000);
  assert.equal(x.months, 5);
  assert.equal(x.recordedMonthly, 5000);
  assert.equal(x.requiredMonthly, 21000);
  assert.equal(x.additionalMonthly, 16000);
  assert.equal(x.feasibility, "above-plan");
  assert.equal(x.capacityGap, 1000);
  assert.equal(x.recordedDate, "Jul 2028");
  assert.equal(x.capacityDate, "Apr 2027");
});

test("a mid-month deadline excludes that month's end-of-month contribution", () => {
  const mid = goalTargetDateFor(args({ deadline: "2027-03-20" }));
  assert.equal(mid.months, 4);
  assert.equal(mid.requiredMonthly, 26250);
  const firstMonth = goalTargetDateFor(args({ deadline: "2026-11-30" }));
  assert.equal(firstMonth.months, 1);
  assert.equal(firstMonth.requiredMonthly, 105000);
  const tooEarly = goalTargetDateFor(args({ deadline: "2026-11-29" }));
  assert.equal(tooEarly.reason, "no-paydays");
  assert.equal(tooEarly.requiredMonthly, null);
  const sameMonth = goalTargetDateFor(args({ deadline: "2026-10-31" }));
  assert.equal(sameMonth.reason, "no-paydays");
});

test("a longer deadline within plan is still caveated; never equate plan with spare cash", () => {
  const x = goalTargetDateFor(args({ deadline: "2027-04-30" }));
  assert.equal(x.months, 6);
  assert.equal(x.requiredMonthly, 17500);
  assert.equal(x.feasibility, "within-plan");
  assert.equal(x.capacityGap, 0);
  const unknown = goalTargetDateFor(args({ monthlyCapacity: null }));
  assert.equal(unknown.feasibility, "unknown");
  assert.equal(unknown.capacityDate, null);
  assert.equal(unknown.capacityGap, null);
  const zero = goalTargetDateFor(args({ monthlyCapacity: 0 }));
  assert.equal(zero.feasibility, "above-plan");
  assert.equal(zero.capacityDate, null);
  const invalid = goalTargetDateFor(args({ monthlyCapacity: Number.NaN }));
  assert.equal(invalid.feasibility, "unknown");
});

test("locked, paused, completed and no-target goals never show a misleading requirement", () => {
  const balances = { emergency: 195000, "home-trip": 5000, equipment: 0 };
  const waiting = goalTargetDateFor(args({ goal: goals[1], bucketBalances: balances }));
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.reason, "waiting");
  assert.equal(waiting.requiredMonthly, null);
  assert.equal(waiting.feasibility, "unknown");
  const unlocked = goalTargetDateFor(args({
    goal: goals[1], bucketBalances: { ...balances, emergency: 200000 },
  }));
  assert.equal(unlocked.reason, null);
  assert.equal(unlocked.requiredMonthly, 19000);
  const paused = goalTargetDateFor(args({ goal: goals[2], bucketBalances: balances }));
  assert.equal(paused.reason, "paused");
  assert.equal(paused.requiredMonthly, null);
  const complete = goalTargetDateFor(args({ bucketBalances: { emergency: 300000 } }));
  assert.equal(complete.reason, "complete");
  assert.equal(complete.requiredMonthly, null);
  const targetless = goalTargetDateFor(args({
    goal: { id: "targetless", bucketId: "emergency", targetAmount: 0, status: "active" },
  }));
  assert.equal(targetless.reason, "no-target");
  assert.equal(goalTargetDateFor({ goal: null }), null);
});

test("date validation rejects impossible, missing and out-of-range dates", () => {
  for (const deadline of ["", "2027-02-30", "2027-13-01", "2027-00-31", "foo",
    "2027-03-31T01:00:00Z", "10000-01-01", "2027-3-31", "2027-04-00"]) {
    const result = goalTargetDateFor(args({ deadline }));
    assert.equal(result.reason, "invalid-date", String(deadline));
    assert.equal(result.requiredMonthly, null);
  }
  const leap = goalTargetDateFor(args({ deadline: "2028-02-29" }));
  assert.equal(leap.reason, null);
  assert.ok(leap.months > 0);
  const expired = goalTargetDateFor(args({ deadline: "2025-12-31" }));
  assert.equal(expired.reason, "no-paydays");
});

test("zero completed history means the required monthly amount is entirely additional", () => {
  const x = goalTargetDateFor(args({ recentHistory: [] }));
  assert.equal(x.recordedMonthly, 0);
  assert.equal(x.requiredMonthly, 21000);
  assert.equal(x.additionalMonthly, 21000);
  assert.equal(x.recordedDate, null);
});

test("target-date calculator is deterministic and does not mutate financial source records", () => {
  const src = args();
  const before = structuredClone({ goals: src.goals, history: src.recentHistory, balances: src.bucketBalances });
  const first = goalTargetDateFor(src);
  const second = goalTargetDateFor(src);
  assert.deepEqual(first, second);
  assert.deepEqual({ goals: src.goals, history: src.recentHistory, balances: src.bucketBalances }, before);
});
