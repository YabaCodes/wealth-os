import test from "node:test";
import assert from "node:assert/strict";
import {
  allowanceDays,
  totalFlexibleAllowance,
  elapsedAllowanceDays,
  projectBudgetSummary,
  mapLegacyBusinessExpense,
  parseCustomCategoryRules,
  effectiveTwd,
  unresolvedDeposits,
} from "../js/special-budgets.js";

test("business trip allowance merges departure and return into one allowance day", () => {
  const project = {
    type: "business_trip",
    startDate: "2026-10-15",
    endDate: "2026-11-03",
    dailyAllowanceTwd: 3000,
  };
  assert.equal(allowanceDays(project.startDate, project.endDate), 19);
  assert.equal(totalFlexibleAllowance(project), 57000);
  assert.equal(elapsedAllowanceDays(project, "2026-10-15"), 0.5);
  assert.equal(elapsedAllowanceDays(project, "2026-10-18"), 3.5);
  assert.equal(elapsedAllowanceDays(project, "2026-11-03"), 19);
});

test("business trip summary separates exact reimbursement from flexible allowance spending", () => {
  const project = {
    type: "business_trip",
    startDate: "2026-10-15",
    endDate: "2026-11-03",
    dailyAllowanceTwd: 3000,
    tripWalletAllocatedTwd: 0,
  };
  const expenses = [
    { categoryId: "hotel_rental", category: "Hotel Rental", reimbursementType: "exact", twdAmount: 6492 },
    { categoryId: "train_ticket", category: "Train Ticket", reimbursementType: "exact", twdAmount: 2942 },
    { categoryId: "food", category: "Food", reimbursementType: "flexible", twdAmount: 531 },
    { categoryId: "shopping", category: "Shopping", reimbursementType: "flexible", twdAmount: 1829 },
  ];
  const s = projectBudgetSummary(project, expenses, "2026-10-18");
  assert.equal(s.exact, 9434);
  assert.equal(s.flexible, 2360);
  assert.equal(s.allowance, 57000);
  assert.equal(s.expectedReimbursement, 66434);
  assert.equal(s.expectedResult, 54640);
  assert.equal(s.totalAllowanceDays, 19);
  assert.equal(s.elapsedAllowanceDays, 3.5);
});

test("pending refundable deposits are excluded from spend and settlement totals", () => {
  const project = {
    type: "business_trip",
    startDate: "2026-10-15",
    endDate: "2026-11-03",
    dailyAllowanceTwd: 3000,
  };
  const deposit = {
    categoryId: "car_rental",
    category: "Car Rental",
    reimbursementType: "exact",
    recordType: "refundable_deposit",
    depositStatus: "pending",
    twdAmount: 10936,
  };
  const s = projectBudgetSummary(project, [deposit], "2026-10-18");
  assert.equal(effectiveTwd(deposit), 0);
  assert.equal(s.exact, 0);
  assert.equal(s.totalSpend, 0);
  assert.equal(s.depositsPending, 1);
  assert.equal(s.depositsPendingTwd, 10936);
  assert.equal(unresolvedDeposits([deposit]).length, 1);
});

test("retained deposit amount becomes a real expense only after resolution", () => {
  const partial = {
    categoryId: "car_rental",
    category: "Car Rental",
    reimbursementType: "exact",
    recordType: "refundable_deposit",
    depositStatus: "partial",
    twdAmount: 10936,
    retainedTwd: 2000,
  };
  const refunded = { ...partial, depositStatus: "refunded", retainedTwd: null };
  assert.equal(effectiveTwd(partial), 2000);
  assert.equal(effectiveTwd(refunded), 0);
});

test("legacy business-trip rows map into the new template without changing amounts", () => {
  assert.deepEqual(
    mapLegacyBusinessExpense({ category: "Hotel", description: "Frankfurt Hotel" }),
    { categoryId: "hotel_rental", category: "Hotel Rental", reimbursementType: "exact", recordType: "expense" },
  );
  assert.deepEqual(
    mapLegacyBusinessExpense({ category: "Other", description: "Power bank" }),
    { categoryId: "shopping", category: "Shopping", reimbursementType: "flexible", recordType: "expense" },
  );
  const deposit = mapLegacyBusinessExpense({ category: "Car Rental", description: "Car rental deposit" });
  assert.equal(deposit.recordType, "refundable_deposit");
  assert.equal(deposit.depositStatus, "pending");
  assert.equal(deposit.categoryId, "car_rental");
});

test("custom Special Budget category rules are built from user-entered lines", () => {
  const rules = parseCustomCategoryRules({
    exact: "Hotel\nTrain",
    flexible: "Food\nShopping",
    tracking: "Notes",
  });
  assert.deepEqual(rules.map((x) => [x.name, x.treatment]), [
    ["Hotel", "exact"],
    ["Train", "exact"],
    ["Food", "flexible"],
    ["Shopping", "flexible"],
    ["Notes", "tracking"],
  ]);
});
