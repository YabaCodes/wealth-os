import test from "node:test";
import assert from "node:assert/strict";
import {
  effectiveTwd, missingTwd, usesTripCashRate, tripCashEstimateTwd,
  projectBudgetSummary, projectCategoryBreakdown, businessTripPaymentSourcesFor,
} from "../js/special-budgets.js";
import {
  projectKnownTwd, projectMissingTwd, projectPaymentTwd,
} from "../js/projects.js";

const trip = {
  id: "synthetic", type: "business_trip", defaultCurrency: "EUR",
  cashFxRateTwd: 36.4, startDate: "2026-10-15", endDate: "2026-10-20",
  dailyAllowanceTwd: 3000,
};
const cash = (extra = {}) => ({
  id: "cash-1", projectId: trip.id,
  paymentMethod: "cash", cashRateMode: "trip", categoryId: "food", reimbursementType: "flexible",
  recordType: "expense", originalAmount: 10, currency: "EUR", twdAmount: null, ...extra,
});
const bank = (extra = {}) => ({
  id: "card-1", projectId: trip.id,
  paymentMethod: "esun_card", categoryId: "hotel_rental", reimbursementType: "exact",
  recordType: "expense", originalAmount: 20, currency: "EUR", twdAmount: 750, ...extra,
});

test("trip cash uses one rate without persisting a made-up exact bank charge", () => {
  const c = cash();
  const before = structuredClone(c);
  assert.equal(usesTripCashRate(c, trip), true);
  assert.equal(effectiveTwd(c, trip), 364);
  assert.equal(missingTwd(c, trip), false);
  assert.deepEqual(c, before);
  assert.equal(effectiveTwd(c, { ...trip, cashFxRateTwd: 37 }), 370);
  assert.equal(effectiveTwd(c, { ...trip, cashFxRateTwd: null }), 0);
  assert.equal(missingTwd(c, { ...trip, cashFxRateTwd: null }), true);
  assert.equal(tripCashEstimateTwd(10, "CHF", trip), 0);
  assert.equal(missingTwd(cash({ currency: "CHF" }), trip), true);
});

test("bank charge stays exact while cash adjusts; legacy cash exact remains untouched", () => {
  const entries = [
    bank(), bank({ id: "debit", paymentMethod: "ctbc", twdAmount: 420 }),
    cash(), cash({ id: "legacy", cashRateMode: undefined, twdAmount: 390 }),
  ];
  assert.equal(projectKnownTwd(entries, trip.id, trip), 1924);
  assert.equal(projectPaymentTwd(entries, trip.id, "esun_card", trip), 750);
  assert.equal(projectPaymentTwd(entries, trip.id, "ctbc", trip), 420);
  assert.equal(projectPaymentTwd(entries, trip.id, "cash", trip), 754);
  assert.equal(projectMissingTwd(entries, trip.id, trip).length, 0);
  const next = { ...trip, cashFxRateTwd: 37 };
  assert.equal(projectKnownTwd(entries, trip.id, next), 1930);
  assert.equal(effectiveTwd(entries[3], next), 390);
  assert.equal(effectiveTwd(cash({currency:"TWD", originalAmount:77}), trip), 77);
  assert.equal(missingTwd(bank({ twdAmount: null }), trip), true);
});

test("cash estimates flow through exact/flexible trackers and payment-source ledger separately from bank funding", () => {
  const expenses = [cash(), bank(), cash({ id: "cash-hotel", categoryId: "hotel_rental", reimbursementType: "exact", originalAmount: 5 })];
  const summary = projectBudgetSummary(trip, expenses, "2026-10-18");
  assert.equal(summary.exact, 932);
  assert.equal(summary.flexible, 364);
  assert.equal(summary.totalSpend, 1296);
  const exact = projectCategoryBreakdown(trip, expenses, "exact");
  assert.equal(exact.find((x) => x.id === "hotel_rental").amount, 932);
  const sources = businessTripPaymentSourcesFor(expenses, null, trip);
  assert.equal(sources.total, 1296);
  assert.equal(sources.cardKnownTwd, 750);
  assert.equal(sources.estimatedCashTwd, 546);
  assert.equal(sources.estimatedCashCount, 2);
  assert.equal(sources.unvalued, 0);
  const noRate = businessTripPaymentSourcesFor(expenses, null, { ...trip, cashFxRateTwd: null });
  assert.equal(noRate.total, 750);
  assert.equal(noRate.cardKnownTwd, 750);
  assert.equal(noRate.unvalued, 2);
  assert.equal(noRate.estimatedCashTwd, 0);
});

test("partially retained cash deposits use original retained currency and the same trip rate", () => {
  const hold = cash({
    recordType: "refundable_deposit", depositStatus: "pending",
    originalAmount: 50, retainedOriginalAmount: null,
  });
  assert.equal(effectiveTwd(hold, trip), 0);
  assert.equal(missingTwd(hold, trip), false);
  const partial = { ...hold, depositStatus: "partial", retainedOriginalAmount: 12 };
  assert.equal(effectiveTwd(partial, trip), 437);
  assert.equal(missingTwd(partial, trip), false);
  assert.equal(effectiveTwd(partial, { ...trip, cashFxRateTwd: null }), 0);
  assert.equal(missingTwd(partial, { ...trip, cashFxRateTwd: null }), true);
  const sources = businessTripPaymentSourcesFor([partial], null, trip);
  assert.equal(sources.estimatedCashTwd, 437);
  assert.equal(sources.pendingHolds, 0);
  const refunded = { ...partial, depositStatus: "refunded" };
  assert.equal(effectiveTwd(refunded, trip), 0);
  assert.equal(missingTwd(refunded, trip), false);
});
