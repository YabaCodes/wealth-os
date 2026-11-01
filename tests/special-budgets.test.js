import test from "node:test";
import assert from "node:assert/strict";
import {
  allowanceDays,
  businessTripCategoryRules,
  totalFlexibleAllowance,
  elapsedAllowanceDays,
  projectBudgetSummary,
  projectCategoryBreakdown,
  preferredProjectEntryCategoryId,
  projectCompositionBreakdown,
  mapLegacyBusinessExpense,
  parseCustomCategoryRules,
  effectiveTwd,
  unresolvedDeposits,
  businessTripPaymentSourcesFor,
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


test("legacy Business Trip mapping covers the standard travel categories", () => {
  const cases = [
    [{ category: "Car Rental", description: "Parking" }, "parking_ticket", "exact"],
    [{ category: "Transport", description: "Train" }, "train_ticket", "exact"],
    [{ category: "Other", description: "SIM card" }, "sim_card", "exact"],
    [{ category: "Car Rental", description: "Car Rental" }, "car_rental", "exact"],
    [{ category: "Other", description: "Haircut" }, "personal_expenses", "flexible"],
    [{ category: "Other", description: "2wks Gym" }, "personal_expenses", "flexible"],
    [{ category: "Food", description: "Lunch" }, "food", "flexible"],
  ];
  for (const [input, categoryId, treatment] of cases) {
    const mapped = mapLegacyBusinessExpense(input);
    assert.equal(mapped.categoryId, categoryId);
    assert.equal(mapped.reimbursementType, treatment);
  }
});

test("Trip Wallet summary deducts counted spend while refundable holds stay outside it", () => {
  const project = {
    type: "business_trip",
    startDate: "2026-10-15",
    endDate: "2026-11-03",
    dailyAllowanceTwd: 3000,
    tripWalletAllocatedTwd: 20000,
  };
  const expenses = [
    { categoryId: "food", reimbursementType: "flexible", twdAmount: 3000 },
    { categoryId: "hotel_rental", reimbursementType: "exact", twdAmount: 5000 },
    {
      categoryId: "car_rental",
      reimbursementType: "exact",
      recordType: "refundable_deposit",
      depositStatus: "pending",
      twdAmount: 10000,
    },
  ];
  const summary = projectBudgetSummary(project, expenses, "2026-10-18");
  assert.equal(summary.totalSpend, 8000);
  assert.equal(summary.walletAllocated, 20000);
  assert.equal(summary.walletRemaining, 12000);
  assert.equal(summary.depositsPendingTwd, 10000);
});


test("Special Budget category breakdown groups exact and flexible spending without counting pending deposits", () => {
  const project = {
    type: "business_trip",
    categoryRules: [
      { id: "hotel_rental", name: "Hotel Rental", treatment: "exact" },
      { id: "train_ticket", name: "Train Ticket", treatment: "exact" },
      { id: "food", name: "Food", treatment: "flexible" },
      { id: "shopping", name: "Shopping", treatment: "flexible" },
    ],
  };
  const expenses = [
    { categoryId: "hotel_rental", category: "Hotel Rental", reimbursementType: "exact", twdAmount: 6000 },
    { categoryId: "train_ticket", category: "Train Ticket", reimbursementType: "exact", twdAmount: 3000 },
    { categoryId: "food", category: "Food", reimbursementType: "flexible", twdAmount: 500 },
    { categoryId: "food", category: "Food", reimbursementType: "flexible", twdAmount: 700 },
    {
      categoryId: "hotel_rental",
      category: "Hotel Rental",
      reimbursementType: "exact",
      recordType: "refundable_deposit",
      depositStatus: "pending",
      twdAmount: 10000,
    },
  ];

  const exact = projectCategoryBreakdown(project, expenses, "exact");
  const flexible = projectCategoryBreakdown(project, expenses, "flexible");
  assert.deepEqual(exact.map((x) => [x.id, x.amount, x.count]), [
    ["hotel_rental", 6000, 1],
    ["train_ticket", 3000, 1],
  ]);
  assert.deepEqual(flexible.map((x) => [x.id, x.amount, x.count]), [
    ["food", 1200, 2],
    ["shopping", 0, 0],
  ]);
});


test("exact reimbursement composition totals 100% of confirmed claims with no remaining category", () => {
  const project = { type: "business_trip" };
  const expenses = [
    { categoryId: "car_rental", reimbursementType: "exact", twdAmount: 37230 },
    { categoryId: "hotel_rental", reimbursementType: "exact", twdAmount: 6492 },
    { categoryId: "train_ticket", reimbursementType: "exact", twdAmount: 2942 },
    { categoryId: "sim_card", reimbursementType: "exact", twdAmount: 950 },
    { categoryId: "parking_ticket", reimbursementType: "exact", twdAmount: 439 },
    { categoryId: "car_rental", reimbursementType: "exact", recordType: "refundable_deposit",
      depositStatus: "pending", twdAmount: 10936 },
  ];
  const rows = projectCategoryBreakdown(project, expenses, "exact");
  const result = projectCompositionBreakdown(rows);
  assert.equal(result.spent, 48053);
  assert.equal(result.cap, null);
  assert.equal(result.remaining, 0);
  assert.equal(result.segments.some((segment) => segment.isRemaining), false);
  assert.equal(result.segments.filter((segment) => !segment.isRemaining).length, 5);
  assert.ok(Math.abs(result.segments.reduce((sum, s) => sum + s.barPct, 0) - 100) < 0.00001);
  assert.ok(result.segments.every((s) => s.barPct >= 0 && s.barPct <= 100));
  assert.equal(result.segments.find((s) => s.id === "car_rental").amount, 37230);
});

test("flexible composition uses category spend plus unspent allowance as one 100% bar", () => {
  const rows = [
    { id: "food", name: "Food", amount: 1065, count: 2 },
    { id: "shopping", name: "Shopping", amount: 1829, count: 1 },
    { id: "personal_expenses", name: "Personal Expenses", amount: 2562, count: 2 },
    { id: "others", name: "Others", amount: 0, count: 0 },
  ];
  const result = projectCompositionBreakdown(rows, 42000);
  assert.equal(result.spent, 5456);
  assert.equal(result.remaining, 36544);
  assert.equal(result.over, 0);
  assert.equal(result.segments.at(-1).id, "__remaining");
  assert.equal(result.segments.at(-1).amount, 36544);
  assert.ok(Math.abs(result.segments.reduce((sum, s) => sum + s.barPct, 0) - 100) < 0.00001);
  assert.ok(Math.abs(result.segments.find((s) => s.id === "food").allowancePct - (1065 / 42000 * 100)) < 0.00001);
  assert.equal(rows[0].amount, 1065, "composition must not mutate input records");
});

test("flexible composition makes over-allowance spending explicit without a fake remaining segment", () => {
  const result = projectCompositionBreakdown([{ id: "food", amount: 1200 }, { id: "shopping", amount: 1800 }], 2000);
  assert.equal(result.spent, 3000);
  assert.equal(result.over, 1000);
  assert.equal(result.remaining, 0);
  assert.equal(result.visualTotal, 3000);
  assert.equal(result.segments.some((s) => s.isRemaining), false);
  assert.equal(result.segments[0].allowancePct, 60);
  assert.equal(result.segments[1].allowancePct, 90);
  assert.equal(result.segments.reduce((sum, s) => sum + s.barPct, 0), 100);
});

test("zero claim and zero spending allowance composition have safe empty states", () => {
  const empty = projectCompositionBreakdown([], null);
  assert.equal(empty.visualTotal, 0);
  assert.deepEqual(empty.segments, []);
  const unused = projectCompositionBreakdown([], 42000);
  assert.equal(unused.segments.length, 1);
  assert.equal(unused.segments[0].barPct, 100);
  const noCap = projectCompositionBreakdown([{ id: "food", amount: 400 }], 0);
  assert.equal(noCap.over, 400);
  assert.equal(noCap.segments[0].barPct, 100);
  assert.equal(noCap.segments[0].allowancePct, null);
});


test("new Business Trip entries default to Food even when exact categories appear first", () => {
  const rules = businessTripCategoryRules();
  const snapshot = JSON.stringify(rules);
  assert.equal(preferredProjectEntryCategoryId(rules), "food");
  assert.equal(JSON.stringify(rules), snapshot, "default selection must not reorder category rules");
});

test("new custom and legacy Special Budget entries prefer configured Food, else first category", () => {
  assert.equal(preferredProjectEntryCategoryId([
    { id: "accommodation", name: "Accommodation" },
    { id: "daily_food", name: "Food" },
    { id: "transport", name: "Transport" },
  ]), "daily_food");
  assert.equal(preferredProjectEntryCategoryId([
    { id: "train", name: "Train" },
    { id: "hotel", name: "Hotel" },
  ]), "train");
  assert.equal(preferredProjectEntryCategoryId([]), "other");
  assert.equal(preferredProjectEntryCategoryId(null), "other");
});

test("editing Special Budget entries retains the saved category instead of resetting to Food", () => {
  const rules = businessTripCategoryRules();
  assert.equal(preferredProjectEntryCategoryId(rules, { categoryId: "car_rental", category: "Car Rental" }), "car_rental");
  assert.equal(preferredProjectEntryCategoryId(rules, { category: "Shopping" }), "shopping");
  assert.equal(preferredProjectEntryCategoryId(rules, { categoryId: "obsolete_custom_category" }), "obsolete_custom_category");
  assert.equal(preferredProjectEntryCategoryId(rules, { category: "Not Found" }), rules[0].id);
});

test("payment-source composition reconciles all valued trip spend without double counting", () => {
  const entries = [
    { id:"hotel", paymentMethod:"esun_card", recordType:"expense", twdAmount:25000 },
    { id:"meal", paymentMethod:"esun_card", recordType:"expense", twdAmount:2500 },
    { id:"petrol", paymentMethod:"ctbc", recordType:"expense", twdAmount:3000 },
    { id:"cash", paymentMethod:"cash", recordType:"expense", twdAmount:1500 },
    { id:"misc", paymentMethod:"other", recordType:"expense", twdAmount:500 },
    { id:"unknown-method", paymentMethod:null, recordType:"expense", twdAmount:200 },
    { id:"deleted", paymentMethod:"ctbc", twdAmount:20000, deletedAt:"2026-10-18" },
  ];
  const x=businessTripPaymentSourcesFor(entries);
  const totals=Object.fromEntries(x.rows.map(r=>[r.id,r.amount]));
  assert.deepEqual(totals, {esun_card:27500,ctbc:3000,cash:1500,other:700});
  assert.equal(x.total,32700);
  assert.equal(x.cardKnownTwd,27500);
  assert.ok(Math.abs(x.rows.reduce((sum,r)=>sum+r.percentage,0)-100)<1e-8);
  assert.equal(x.pendingHolds,0);
  assert.equal(x.unvalued,0);
  assert.equal(x.cardFundingMarked,false);
});

test("unresolved refundable deposits are authorizations, not expenses or card funding", () => {
  const x=businessTripPaymentSourcesFor([
    {paymentMethod:"esun_card",recordType:"expense",twdAmount:5000},
    {paymentMethod:"esun_card",recordType:"refundable_deposit",depositStatus:"pending",twdAmount:8000},
    {paymentMethod:"ctbc",recordType:"refundable_deposit",depositStatus:"pending",twdAmount:0},
    {paymentMethod:"esun_card",recordType:"refundable_deposit",depositStatus:"refunded",twdAmount:9000},
    {paymentMethod:"esun_card",recordType:"refundable_deposit",depositStatus:"partial",retainedTwd:1200,twdAmount:4000},
    {paymentMethod:"cash",recordType:"refundable_deposit",depositStatus:"retained",retainedTwd:500,twdAmount:500},
  ]);
  assert.equal(x.cardKnownTwd,6200);
  assert.equal(x.total,6700);
  assert.equal(x.pendingHolds,2);
  assert.equal(x.pendingHoldTwd,8000);
  assert.equal(x.rows.find(r=>r.id==="esun_card").pendingHoldTwd,8000);
  assert.equal(x.unvalued,0);
});

test("missing NTD card entries stay visible as incomplete and do not pretend to be exact", () => {
  const x=businessTripPaymentSourcesFor([
    {paymentMethod:"esun_card",recordType:"expense",twdAmount:2500},
    {paymentMethod:"esun_card",recordType:"expense",twdAmount:null},
    {paymentMethod:"cash",recordType:"expense",twdAmount:0},
    {paymentMethod:"ctbc",recordType:"expense",twdAmount:1700},
  ]);
  assert.equal(x.cardKnownTwd,2500);
  assert.equal(x.unvalued,2);
  assert.equal(x.rows.find(r=>r.id==="esun_card").unknownTwdCount,1);
  assert.equal(x.rows.find(r=>r.id==="cash").unknownTwdCount,1);
  assert.equal(x.total,4200);
});

test("after settlement card source uses frozen card tally and manually marked status, without mutating rows", () => {
  const entries=[{id:"one",paymentMethod:"esun_card",recordType:"expense",twdAmount:4000}];
  const frozen=structuredClone(entries);
  const x=businessTripPaymentSourcesFor(entries,{
    cardPaidTwd:3900,cardClearingConfirmed:true,
  });
  assert.equal(x.cardKnownTwd,3900);
  assert.equal(x.cardFundingMarked,true);
  assert.equal(x.rows.find(r=>r.id==="esun_card").amount,4000);
  assert.deepEqual(entries,frozen);
  assert.equal(businessTripPaymentSourcesFor().total,0);
});
