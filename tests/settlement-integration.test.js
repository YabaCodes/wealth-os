// v1.20.2 Special Budget settlement/undo integration coverage.
// Uses real production settlement-storage + js/db APIs with synthetic IDB data.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  clearStore, seedIfNeeded, getAll, getOne, put, exportData, accountBalances,
} from "../js/db.js";
import { projectBudgetSummary } from "../js/special-budgets.js";
import {
  projectExpensesFor, projectKnownTwd, projectPaymentTwd,
} from "../js/projects.js";
import {
  commitSpecialBudgetSettlementAtomic, undoSpecialBudgetSettlementAtomic,
} from "../js/settlement-storage.js";

const STORES = [
  "accounts", "buckets", "categories", "goals", "periods", "incomes",
  "expenses", "transfers", "transferAllocations", "investmentSnapshots",
  "reconciliations", "adjustments", "monthlyCloses", "projects",
  "projectExpenses", "projectSettlements", "settings",
];
const STAMP = "2026-10-18T16:00:00.000Z";
const PROJECT_ID = "test-trip";
const openPeriod = "2026-10";

async function reset() {
  for (const name of STORES) await clearStore(name);
  await seedIfNeeded();
  await put("periods", { id: openPeriod, state: "funded" });
  await put("projects", {
    id: PROJECT_ID, type: "business_trip", title: "Synthetic Germany trip",
    startDate: "2026-10-16", endDate: "2026-10-30",
    dailyAllowanceTwd: 3000, reimbursementAccountId: "ctbc",
    status: "active",
  });
  await put("projectExpenses", {
    id: "train", projectId: PROJECT_ID, reimbursementType: "exact",
    categoryId: "train_ticket", category: "Train Ticket", twdAmount: 4000,
    paymentMethod: "esun_card", recordType: "expense",
  });
  await put("projectExpenses", {
    id: "hotel", projectId: PROJECT_ID, reimbursementType: "exact",
    categoryId: "hotel_rental", category: "Hotel Rental", twdAmount: 6000,
    paymentMethod: "esun_card", recordType: "expense",
  });
  await put("projectExpenses", {
    id: "food", projectId: PROJECT_ID, reimbursementType: "flexible",
    categoryId: "food", category: "Food", twdAmount: 1000,
    paymentMethod: "cash", recordType: "expense",
  });
}

async function pendingDeposit() {
  await put("projectExpenses", {
    id: "deposit", projectId: PROJECT_ID, reimbursementType: "exact",
    categoryId: "car_rental", category: "Car Rental", recordType: "refundable_deposit",
    depositStatus: "pending", twdAmount: 10936, paymentMethod: "esun_card",
  });
}

async function prepared({ id = "settlement-a", reimbursement = 52000, route = "keep", projectId = PROJECT_ID } = {}) {
  const project = await getOne("projects", projectId);
  const allExpenses = await getAll("projectExpenses");
  const expectedExpenses = projectExpensesFor(allExpenses, projectId);
  const summary = projectBudgetSummary(project, expectedExpenses, "2026-10-18");
  const total = Math.round(projectKnownTwd(allExpenses, projectId));
  const card = Math.round(projectPaymentTwd(allExpenses, projectId, "esun_card"));
  const diff = reimbursement - total;
  const generatedIncome = diff > 0 ? {
    id: "income-" + id, sourceProjectId: projectId, accountId: "ctbc",
    budgetPeriodId: openPeriod, amount: diff, incomeType: "project_surplus",
    includedInRegularIncomeMetrics: false, titheEligible: false,
  } : null;
  const generatedExpense = diff < 0 ? {
    id: "expense-" + id, sourceProjectId: projectId, accountId: "ctbc",
    budgetPeriodId: openPeriod, amount: Math.abs(diff), categoryId: "project-shortfall",
    excludeFromBudget: true,
  } : null;
  const generatedTransfer = diff > 0 && route !== "keep" ? {
    id: "transfer-" + id, sourceProjectId: projectId, budgetPeriodId: openPeriod,
    fromAccountId: "ctbc", toAccountId: "esun", amount: diff,
    status: "planned", affectsPhysicalBalance: true, transferType: "project_surplus_routing",
  } : null;
  const generatedAllocation = generatedTransfer ? {
    id: "allocation-" + id, transferId: generatedTransfer.id,
    bucketId: "emergency", amount: diff,
  } : null;
  const settlement = {
    id, projectId, reimbursementTwd: reimbursement,
    expectedReimbursementTwd: project.type === "business_trip" ? Math.round(summary.expectedReimbursement) : null,
    totalProjectCostTwd: total, exactReimbursableTwd: project.type === "business_trip" ? Math.round(summary.exact) : null,
    flexibleAllowanceTwd: project.type === "business_trip" ? Math.round(summary.allowance) : null,
    flexibleSpentTwd: project.type === "business_trip" ? Math.round(summary.flexible) : null,
    differenceTwd: diff, cardPaidTwd: card, cashOtherTwd: Math.max(0, total - card),
    surplusRoute: route, generatedIncomeId: generatedIncome?.id || null,
    generatedExpenseId: generatedExpense?.id || null, generatedTransferId: generatedTransfer?.id || null,
    createdAt: STAMP, updatedAt: STAMP,
  };
  return { projectId, expectedExpenses, settlement, generatedIncome, generatedExpense, generatedTransfer, generatedAllocation };
}

test("Business Trip settlement posts only final surplus and preserves full allowance reimbursement", async () => {
  await reset();
  const params = await prepared({ route: "emergency" });
  assert.equal(params.settlement.exactReimbursableTwd, 10000);
  assert.equal(params.settlement.flexibleAllowanceTwd, 42000);
  assert.equal(params.settlement.expectedReimbursementTwd, 52000);
  assert.equal(params.settlement.totalProjectCostTwd, 11000);
  assert.equal(params.settlement.differenceTwd, 41000);
  await commitSpecialBudgetSettlementAtomic(params);
  const st = await getOne("projectSettlements", "settlement-a");
  assert.equal(st.generatedIncomeId, "income-settlement-a");
  assert.equal((await getOne("incomes", st.generatedIncomeId)).amount, 41000);
  assert.equal((await getOne("transfers", st.generatedTransferId)).status, "planned");
  assert.equal((await getOne("transferAllocations", "allocation-settlement-a")).amount, 41000);
  assert.equal((await getOne("projects", PROJECT_ID)).status, "settled");
  assert.equal((await getAll("expenses")).length, 0);
  assert.equal((await accountBalances()).ctbc, 41000);
  assert.equal((await getAll("projectExpenses")).length, 3);
});

test("undo removes linked income, planned transfer and allocations together, without touching original expenses", async () => {
  await reset();
  await commitSpecialBudgetSettlementAtomic(await prepared({ route: "emergency" }));
  const before = await getAll("projectExpenses");
  await undoSpecialBudgetSettlementAtomic(PROJECT_ID, "2026-10-18T17:00:00.000Z");
  assert.equal((await getAll("projectSettlements")).length, 0);
  assert.equal((await getAll("incomes")).length, 0);
  assert.equal((await getAll("transfers")).length, 0);
  assert.equal((await getAll("transferAllocations")).length, 0);
  assert.equal((await getOne("projects", PROJECT_ID)).status, "active");
  assert.deepEqual(await getAll("projectExpenses"), before);
  assert.equal((await accountBalances()).ctbc, 0);
});

test("concurrent settlement submissions cannot create duplicate income or settlements", async () => {
  await reset();
  const first = await prepared({ id: "first" });
  const second = await prepared({ id: "second" });
  const results = await Promise.allSettled([
    commitSpecialBudgetSettlementAtomic(first), commitSpecialBudgetSettlementAtomic(second),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal((await getAll("projectSettlements")).length, 1);
  assert.equal((await getAll("incomes")).length, 1);
  assert.equal((await getOne("projects", PROJECT_ID)).status, "settled");
});

test("unresolved refundable deposit prevents settlement without altering any stored record", async () => {
  await reset();
  await pendingDeposit();
  const params = await prepared();
  const before = (await exportData()).data;
  await assert.rejects(commitSpecialBudgetSettlementAtomic(params), /Resolve refundable deposits/);
  assert.deepEqual((await exportData()).data, before);
  await put("projectExpenses", {
    ...(await getOne("projectExpenses", "deposit")), depositStatus: "refunded",
  });
  const refreshed = await prepared();
  await commitSpecialBudgetSettlementAtomic(refreshed);
  assert.equal((await getOne("projectSettlements", "settlement-a")).totalProjectCostTwd, 11000);
});

test("stale expense data, missing TWD and a closed funding month each block the entire transaction", async () => {
  await reset();
  const stale = await prepared();
  await put("projectExpenses", { ...(await getOne("projectExpenses", "food")), twdAmount: 1800 });
  const current = (await exportData()).data;
  await assert.rejects(commitSpecialBudgetSettlementAtomic(stale), /entries changed/);
  assert.deepEqual((await exportData()).data, current);
  await put("projectExpenses", { ...(await getOne("projectExpenses", "food")), twdAmount: null });
  const missing = await prepared();
  const beforeMissing = (await exportData()).data;
  await assert.rejects(commitSpecialBudgetSettlementAtomic(missing), /exact NTD/);
  assert.deepEqual((await exportData()).data, beforeMissing);
  await put("projectExpenses", { ...(await getOne("projectExpenses", "food")), twdAmount: 1000 });
  const closed = await prepared();
  await put("periods", { id: openPeriod, state: "closed" });
  const beforeClosed = (await exportData()).data;
  await assert.rejects(commitSpecialBudgetSettlementAtomic(closed), /Funding month closed/);
  assert.deepEqual((await exportData()).data, beforeClosed);
});

test("uncloneable generated income aborts all queued writes without partial settlement", async () => {
  await reset();
  const params = await prepared({ route: "emergency" });
  params.generatedIncome = { ...params.generatedIncome, cannotClone: () => "fail" };
  const before = (await exportData()).data;
  await assert.rejects(commitSpecialBudgetSettlementAtomic(params), (err) => err.name === "DataCloneError");
  assert.deepEqual((await exportData()).data, before);
});

test("completed surplus transfer blocks undo without deleting the settlement or income", async () => {
  await reset();
  await commitSpecialBudgetSettlementAtomic(await prepared({ route: "emergency" }));
  const t = await getOne("transfers", "transfer-settlement-a");
  await put("transfers", { ...t, status: "completed" });
  const before = (await exportData()).data;
  await assert.rejects(undoSpecialBudgetSettlementAtomic(PROJECT_ID, STAMP), /already completed/);
  assert.deepEqual((await exportData()).data, before);
});

test("custom Special Budget shortfall is the only personal expense; undo deletes it", async () => {
  await reset();
  await put("projects", {
    ...(await getOne("projects", PROJECT_ID)), type: "custom",
    flexibleCapTwd: 0,
  });
  const params = await prepared({ reimbursement: 9000, id: "shortfall" });
  assert.equal(params.settlement.totalProjectCostTwd, 11000);
  assert.equal(params.settlement.differenceTwd, -2000);
  assert.equal(params.generatedIncome, null);
  await commitSpecialBudgetSettlementAtomic(params);
  assert.equal((await getAll("incomes")).length, 0);
  const expense = await getOne("expenses", "expense-shortfall");
  assert.equal(expense.amount, 2000);
  assert.equal(expense.excludeFromBudget, true);
  assert.equal((await accountBalances()).ctbc, -2000);
  await undoSpecialBudgetSettlementAtomic(PROJECT_ID, STAMP);
  assert.equal((await getAll("expenses")).length, 0);
  assert.equal((await getAll("projectSettlements")).length, 0);
});

test("equal reimbursement and cost settles with no generated personal-ledger activity", async () => {
  await reset();
  const params = await prepared({ reimbursement: 11000, id: "break-even" });
  await commitSpecialBudgetSettlementAtomic(params);
  assert.equal((await getAll("incomes")).length, 0);
  assert.equal((await getAll("expenses")).length, 0);
  assert.equal((await getAll("transfers")).length, 0);
  await undoSpecialBudgetSettlementAtomic(PROJECT_ID, STAMP);
  assert.equal((await getAll("projectSettlements")).length, 0);
});
