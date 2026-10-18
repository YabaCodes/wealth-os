// Regression coverage runs the SAME migration, period guard, and plan-sync modules
// used by Wealth OS against its actual js/db.js IndexedDB transactions.
// All fixtures are synthetic and never read or overwrite real financial data.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  clearStore, seedIfNeeded, getOne, getAll, put, bulkPut, exportData,
  accountBalances, bucketBalances,
} from "../js/db.js";
import { migrateV182, migrateV190 } from "../js/migrations.js";
import {
  isClosedPeriod, assertPeriodEditable, syncOpenMonthPlanPersisted,
} from "../js/period-safety.js";

const STORES = [
  "accounts", "buckets", "categories", "goals", "periods", "incomes",
  "expenses", "transfers", "transferAllocations", "investmentSnapshots",
  "reconciliations", "adjustments", "monthlyCloses", "projects",
  "projectExpenses", "projectSettlements", "settings",
];
const MONTH_OPEN = "2026-10";
const MONTH_CLOSED = "2026-09";
const STAMP = "2026-10-18T15:00:00.000Z";

async function reset() {
  for (const store of STORES) await clearStore(store);
  await seedIfNeeded();
}

function snap(lines) {
  return { salary: 80000, lines, fixed: 7000, caps: 13000, sinking: 0, buffer: 2000,
    immediateWealth: 58000, assignedBeforeWealth: 22000 };
}
function syntheticLines() {
  return [
    { id: "food", name: "Food", ruleType: "cap", budgetAmount: 10000 },
    { id: "rent", name: "Rent", ruleType: "fixed", budgetAmount: 7000 },
  ];
}
async function seedPeriods() {
  const prior = snap(syntheticLines());
  const open = { id: MONTH_OPEN, state: "funded", planSnapshot: structuredClone(prior), budgetRevision: 1 };
  const closed = { id: MONTH_CLOSED, state: "closed", planSnapshot: structuredClone(prior), closedAt: STAMP };
  await bulkPut("periods", [open, closed]);
  await put("monthlyCloses", {
    id: MONTH_CLOSED, budgetPeriodId: MONTH_CLOSED, status: "closed",
    planSnapshot: structuredClone(prior), expenses: 250, wealthContribution: 1000,
    endingAccountBalances: { ctbc: 15000, esun: 7000 },
  });
  await bulkPut("expenses", [
    { id: "closed-expense", budgetPeriodId: MONTH_CLOSED, accountId: "ctbc", categoryId: "food", amount: 250 },
    { id: "open-expense", budgetPeriodId: MONTH_OPEN, accountId: "ctbc", categoryId: "food", amount: 420 },
  ]);
  await bulkPut("transfers", [
    { id: "closed-transfer", budgetPeriodId: MONTH_CLOSED, status: "completed",
      fromAccountId: "ctbc", toAccountId: "esun", amount: 1000 },
    { id: "open-transfer", budgetPeriodId: MONTH_OPEN, status: "completed",
      fromAccountId: "ctbc", toAccountId: "esun", amount: 350 },
  ]);
  await put("transferAllocations", {
    id: "actual-allocation", transferId: "open-transfer", bucketId: "emergency", amount: 350,
  });
  await put("reconciliations", {
    id: "prior-bank-check", accountId: "ctbc", date: "2026-09-30",
    actualBalance: 15000, expectedBalance: 14900,
  });
  await put("incomes", {
    id: "current-paycheck", accountId: "ctbc", budgetPeriodId: MONTH_OPEN,
    incomeType: "regular_income", amount: 80000,
  });
  return { open, closed };
}

function unchangedFinancialStores(before, after) {
  for (const name of [
    "incomes", "expenses", "transfers", "transferAllocations",
    "reconciliations", "adjustments", "monthlyCloses",
    "projects", "projectExpenses", "projectSettlements",
  ]) assert.deepEqual(after[name], before[name], name + " must not be rewritten");
}

test("v182 migration updates an open plan with zero Household but freezes closed months and ledger", async () => {
  await reset();
  await put("settings", { ...(await getOne("settings", "app")), dataModelVersion: 181, appVersion: "1.8.1" });
  const { closed } = await seedPeriods();
  await bulkPut("categories", [
    { id: "water", name: "Water", sort: 33, ruleType: "fixed" },
    { id: "misc", name: "Misc", sort: 34, ruleType: "cap" },
  ]);
  const before = (await exportData()).data;
  await migrateV182();
  const after = (await exportData()).data;
  assert.equal((await getOne("settings", "app")).dataModelVersion, 182);
  const household = await getOne("categories", "household");
  assert.equal(household.defaultAmount, 0);
  assert.equal(household.ruleType, "cap");
  assert.equal(household.sort, 33.5);
  assert.deepEqual(await getOne("periods", MONTH_CLOSED), closed);
  assert.deepEqual((await getOne("periods", MONTH_OPEN)).planSnapshot.lines.at(-1),
    { ...household, budgetAmount: 0 });
  unchangedFinancialStores(before, after);

  // Re-running an already-applied upgrade must be a genuine no-op.
  await migrateV182();
  assert.deepEqual((await exportData()).data, after);
});

test("v182 with an existing Household category never duplicates or edits previous snapshots", async () => {
  await reset();
  await put("settings", { ...(await getOne("settings", "app")), dataModelVersion: 181 });
  await seedPeriods();
  await put("categories", { id: "custom-household", name: "HOUSEHOLD", ruleType: "cap", defaultAmount: 700 });
  const before = (await exportData()).data;
  await migrateV182();
  assert.deepEqual((await getAll("categories")).filter((c) => c.name?.toLowerCase() === "household"),
    [{ id: "custom-household", name: "HOUSEHOLD", ruleType: "cap", defaultAmount: 700 }]);
  const after = (await exportData()).data;
  assert.deepEqual(after.periods, before.periods);
  unchangedFinancialStores(before, after);
});

test("v190 legacy Special Budget upgrade modifies metadata only and is idempotent", async () => {
  await reset();
  await put("settings", { ...(await getOne("settings", "app")), dataModelVersion: 182 });
  await seedPeriods();
  await put("projects", { id: "old-special", title: "Synthetic legacy project", defaultCurrency: "EUR" });
  await put("projectExpenses", { id: "legacy-expense", projectId: "old-special", originalAmount: 120,
    currency: "EUR", twdAmount: 4100, category: "Hotel" });
  await put("projectSettlements", { id: "past-settlement", projectId: "old-special", reimbursementTwd: 4100 });
  const before = (await exportData()).data;
  await migrateV190();
  const after = (await exportData()).data;
  assert.equal((await getOne("settings", "app")).dataModelVersion, 190);
  assert.equal((await getOne("settings", "app")).appVersion, "1.19.0");
  assert.deepEqual(after.periods, before.periods);
  assert.deepEqual(after.categories, before.categories);
  unchangedFinancialStores(before, after);
  await migrateV190();
  assert.deepEqual((await exportData()).data, after);
});

test("closed-month period guard rejects linked changes, while reopened and unlinked records remain editable", async () => {
  await reset();
  await seedPeriods();
  const periods = await getAll("periods");
  assert.equal(isClosedPeriod(periods, MONTH_CLOSED), true);
  assert.equal(isClosedPeriod(periods, MONTH_OPEN), false);
  for (const kind of ["expense", "income", "transfer", "goal contribution"]) {
    assert.throws(() => assertPeriodEditable(periods, MONTH_CLOSED, (id) => id),
      /is closed.*Reopen the month/, kind);
  }
  assert.doesNotThrow(() => assertPeriodEditable(periods, MONTH_OPEN));
  assert.doesNotThrow(() => assertPeriodEditable(periods, null));
  await put("periods", { ...(await getOne("periods", MONTH_CLOSED)), state: "reopened" });
  assert.doesNotThrow(() => assertPeriodEditable(await getAll("periods"), MONTH_CLOSED));
});

test("budget sync changes only the open plan and leaves completed history and closed snapshots byte-equivalent", async () => {
  await reset();
  const { open } = await seedPeriods();
  await bulkPut("categories", [
    { id: "food", name: "Food", group: "Flexible", ruleType: "cap",
      defaultAmount: 9500, active: true, sort: 1 },
    { id: "rent", name: "Rent", group: "Fixed", ruleType: "fixed",
      defaultAmount: 7000, active: true, sort: 2 },
  ]);
  const categories = await getAll("categories");
  const settings = await getOne("settings", "app");
  const before = (await exportData()).data;
  const args = {
    selected: open, categories, settings, stamp: STAMP, salary: 80000,
    goals: [], buckets: await getAll("buckets"), bucketBalances: {},
    completedAllocationToBucket: () => 0,
  };
  assert.equal(await syncOpenMonthPlanPersisted(args), true);
  const synced = await getOne("periods", MONTH_OPEN);
  assert.equal(synced.budgetRevision, 2);
  assert.equal(synced.paydayRoutingSnapshot.reason, "budget_sync");
  assert.equal(synced.planSnapshot.lines.find((c) => c.id === "food").budgetAmount, 9500);
  assert.deepEqual(await getOne("periods", MONTH_CLOSED), before.periods.find((p) => p.id === MONTH_CLOSED));
  unchangedFinancialStores(before, (await exportData()).data);

  // Even a stale form referencing a once-open period cannot resync a persisted closed month.
  await put("periods", { ...synced, state: "closed", closedAt: STAMP });
  const frozen = (await exportData()).data;
  assert.equal(await syncOpenMonthPlanPersisted(args), false);
  assert.deepEqual((await exportData()).data, frozen);
  assert.equal(await syncOpenMonthPlanPersisted({ ...args, selected: { ...open, state: "closed" } }), false);
});

test("completed bank transfer, planned transfer and purpose allocation remain disjoint after a plan sync", async () => {
  await reset();
  const { open } = await seedPeriods();
  await put("transfers", { id: "pending-transfer", status: "planned", budgetPeriodId: MONTH_OPEN,
    fromAccountId: "ctbc", toAccountId: "esun", amount: 700 });
  await put("transfers", { id: "purpose-transfer", status: "completed", budgetPeriodId: MONTH_OPEN,
    fromAccountId: "ctbc", toAccountId: "ctbc", transferType: "reserve_allocation",
    affectsPhysicalBalance: false, amount: 600 });
  await put("transferAllocations", { id: "purpose-allocation", transferId: "purpose-transfer",
    bucketId: "electricity", amount: 600 });
  const physicalBefore = await accountBalances();
  const bucketsBefore = await bucketBalances();
  const ledgerBefore = (await exportData()).data;
  assert.equal(physicalBefore.ctbc, 80000 - 420 - 250 - 1350);
  assert.equal(physicalBefore.esun, 1350);
  assert.equal(bucketsBefore.electricity, 600);

  await syncOpenMonthPlanPersisted({
    selected: open, categories: await getAll("categories"),
    settings: await getOne("settings", "app"), stamp: STAMP, salary: 80000,
    goals: [], buckets: await getAll("buckets"),
    bucketBalances: bucketsBefore, completedAllocationToBucket: (id) => id === "electricity" ? 600 : 0,
  });
  assert.deepEqual(await accountBalances(), physicalBefore);
  assert.deepEqual(await bucketBalances(), bucketsBefore);
  unchangedFinancialStores(ledgerBefore, (await exportData()).data);
});
