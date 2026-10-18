// Integration coverage for production month-close/reopen module with real DB methods.
// Uses synthetic, isolated fake-indexeddb; never touches the installed PWA's records.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  clearStore, seedIfNeeded, getOne, getAll, put, bulkPut,
  accountBalances, bucketBalances, exportData,
} from "../js/db.js";
import { syncOpenMonthPlanPersisted } from "../js/period-safety.js";
import { assessMonthClose, closeMonthAtomic, reopenMonthAtomic } from "../js/month-close.js";

const STORES = [
  "accounts", "buckets", "categories", "goals", "periods", "incomes",
  "expenses", "transfers", "transferAllocations", "investmentSnapshots",
  "reconciliations", "adjustments", "monthlyCloses", "projects",
  "projectExpenses", "projectSettlements", "settings",
];
const PERIOD_ID = "2026-10";
const OLD_ID = "2026-09";
const STAMP = "2026-10-18T18:00:00.000Z";
const LATER = "2026-10-19T12:00:00.000Z";

async function reset() {
  for (const name of STORES) await clearStore(name);
  await seedIfNeeded();
  const open = {
    id: PERIOD_ID, state: "funded", budgetRevision: 2,
    planSnapshot: {
      salary: 80000, fixed: 7000, caps: 13000, sinking: 4400, buffer: 2000,
      immediateWealth: 53600, lines: [
        { id: "rent", ruleType: "fixed", budgetAmount: 7000 },
        { id: "food", ruleType: "cap", budgetAmount: 13000 },
      ],
    },
  };
  await put("periods", open);
  await put("periods", { id: OLD_ID, state: "closed", planSnapshot: { lines: [] }, closedAt: "2026-09-30" });
  await put("monthlyCloses", {
    id: OLD_ID, budgetPeriodId: OLD_ID, status: "closed",
    expenses: 3500, endingAccountBalances: { ctbc: 30000, esun: 25000 },
    planSnapshot: { lines: [] },
  });
  return open;
}

function snapshot(period, changes = {}) {
  return {
    id: period.id, budgetPeriodId: period.id, status: "closed",
    closedAt: STAMP, snapshotVersion: 1, snapshotDate: "2026-10-18",
    income: 80000, totalIncome: 80000, eligibleIncome: 80000,
    expenses: 12000, wealthContribution: 11000,
    contributionRate: 11000 / 80000, goalFunding: 4400,
    titheAllocated: 8000, sweepAmount: 0, sweepRules: 2,
    sweepBillSavings: 0, sweepBillOverages: 0, sweepPaydayOverSent: 0,
    endingCoreWealth: 150000, endingFinancialNetWorth: 220000,
    endingAccountBalances: { ctbc: 48000, esun: 44000, cash: 2000, ibkrTwd: 10000 },
    endingBucketBalances: { emergency: 70000, tithe: 8000, electricity: 4400 },
    endingEmergency: 70000, endingTithe: 8000,
    endingHomeTravel: 0, endingElectricity: 4400, fxRate: 32.2,
    dataHealthSummary: { critical: 0, warn: 0, info: 0 },
    planSnapshot: structuredClone(period.planSnapshot),
    categoryActuals: { rent: 7000, food: 5000 },
    ctbcActual: 48000, esunActual: 44000,
    missingFixedIds: [],
    ...changes,
  };
}

function ready(overrides = {}) {
  return assessMonthClose({
    p: { id: PERIOD_ID, state: "funded" },
    plan: { sinking: 4400, lines: [] },
    totals: {},
    sweep: { available: 0, overSwept: 0, alreadySwept: 0, rules: 2 },
    pending: [], missingFixed: [],
    ct: { verified: true, difference: 0 },
    es: { verified: true, bankOk: true, allocationOk: true },
    reserveFunded: 4400, titheAllocated: 8000, titheExpected: 8000,
    payday: { totalOutstanding: 0 },
    ...overrides,
  });
}

test("month-close readiness accepts reconciled complete funding and retains unpaid-fixed soft warning", () => {
  const missingFixed = [{ id: "rent", name: "Rent" }];
  const r = ready({ missingFixed });
  assert.equal(r.ready, true);
  assert.deepEqual(r.hardBlockers, []);
  assert.equal(r.missingFixed, missingFixed);
  assert.equal(r.bankOk, true);
  assert.equal(r.fundingOk, true);
});

test("month-close gate retains exact blockers for pending, sweep, allocation, tithe and reconciliation", () => {
  const r = ready({
    pending: [{ id: "pending" }, { id: "another" }],
    sweep: { available: 400, overSwept: 50 },
    reserveFunded: 2000,
    titheAllocated: 6200,
    payday: { totalOutstanding: 300 },
    es: { verified: true, bankOk: true, allocationOk: false },
  });
  assert.equal(r.ready, false);
  assert.deepEqual(r.hardBlockers, [
    "2 planned transfers still pending",
    "NT$400 still available to sweep",
    "NT$50 was swept beyond the current available amount",
    "payday allocations are incomplete",
    "NT$1,800 of tithe is not yet allocated",
    "bank reconciliation or E.SUN purpose allocation is incomplete",
  ]);
  assert.equal(ready({ ct: { verified: false, difference: 0 } }).bankOk, false);
});

test("month-close writes period flag and complete snapshot atomically without modifying other records", async () => {
  const period = await reset();
  await put("expenses", { id: "paid-rent", budgetPeriodId: PERIOD_ID, amount: 7000, categoryId: "rent" });
  await put("transfers", { id: "allocated", budgetPeriodId: PERIOD_ID, status: "completed",
    fromAccountId: "ctbc", toAccountId: "esun", amount: 4400 });
  const before = (await exportData()).data;
  const close = snapshot(period);
  await closeMonthAtomic({ period, snapshot: close, stamp: STAMP });
  assert.deepEqual(await getOne("monthlyCloses", PERIOD_ID), close);
  assert.deepEqual(await getOne("periods", PERIOD_ID), {
    ...period, state: "closed", closedAt: STAMP, updatedAt: STAMP, sweepRules: 2,
  });
  const after = (await exportData()).data;
  for (const name of STORES.filter((x) => !["periods", "monthlyCloses"].includes(x)))
    assert.deepEqual(after[name], before[name], name);
  assert.deepEqual(await getOne("monthlyCloses", OLD_ID), before.monthlyCloses.find((x) => x.id === OLD_ID));
});

test("duplicate close and concurrent submissions cannot overwrite a closed snapshot", async () => {
  const period = await reset();
  const first = { period, snapshot: snapshot(period), stamp: STAMP };
  const second = { period, snapshot: snapshot(period, { income: 900000 }), stamp: LATER };
  const results = await Promise.allSettled([
    closeMonthAtomic(first), closeMonthAtomic(second),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  const persisted = await getOne("monthlyCloses", PERIOD_ID);
  assert.ok([80000, 900000].includes(persisted.income));
  const state = (await exportData()).data;
  await assert.rejects(closeMonthAtomic(first), /already closed/);
  assert.deepEqual((await exportData()).data, state);
});

test("stale open-month preview rejects closing, without writing any snapshot or period state", async () => {
  const period = await reset();
  await put("periods", { ...period, budgetRevision: 3 });
  const before = (await exportData()).data;
  await assert.rejects(
    closeMonthAtomic({ period, snapshot: snapshot(period), stamp: STAMP }),
    /changed.*preview/,
  );
  assert.deepEqual((await exportData()).data, before);
});

test("failed snapshot cloning aborts the period closure and preserves the entire transaction", async () => {
  const period = await reset();
  const bad = snapshot(period, { nested: { uncloneable: () => 1 } });
  const before = (await exportData()).data;
  await assert.rejects(closeMonthAtomic({ period, snapshot: bad, stamp: STAMP }),
    (err) => err.name === "DataCloneError");
  assert.deepEqual((await exportData()).data, before);
});

test("reopen preserves saved close totals; deliberate correction and reclose update only its own month", async () => {
  const period = await reset();
  const original = snapshot(period);
  await closeMonthAtomic({ period, snapshot: original, stamp: STAMP });
  await reopenMonthAtomic(PERIOD_ID, LATER);
  const p = await getOne("periods", PERIOD_ID);
  const reopened = await getOne("monthlyCloses", PERIOD_ID);
  assert.equal(p.state, "reopened");
  assert.equal(reopened.status, "reopened");
  assert.equal(reopened.reopenedAt, LATER);
  assert.equal(reopened.expenses, 12000);
  assert.deepEqual(reopened.planSnapshot, original.planSnapshot);
  assert.deepEqual(await getOne("monthlyCloses", OLD_ID), {
    id: OLD_ID, budgetPeriodId: OLD_ID, status: "closed",
    expenses: 3500, endingAccountBalances: { ctbc: 30000, esun: 25000 },
    planSnapshot: { lines: [] },
  });
  const corrected = snapshot(p, { expenses: 12500, categoryActuals: { rent: 7000, food: 5500 } });
  await closeMonthAtomic({ period: p, snapshot: corrected, stamp: LATER });
  assert.deepEqual(await getOne("monthlyCloses", PERIOD_ID), corrected);
  assert.equal((await getOne("periods", PERIOD_ID)).state, "closed");
});

test("reopening an already-open month fails without creating a partial close record", async () => {
  await reset();
  const before = (await exportData()).data;
  await assert.rejects(reopenMonthAtomic(PERIOD_ID, STAMP), /not closed/);
  assert.deepEqual((await exportData()).data, before);
});

test("budget synchronization cannot rewrite a closed month's stored snapshot", async () => {
  const period = await reset();
  await closeMonthAtomic({ period, snapshot: snapshot(period), stamp: STAMP });
  const before = (await exportData()).data;
  const result = await syncOpenMonthPlanPersisted({
    selected: period, categories: await getAll("categories"),
    settings: await getOne("settings", "app"), stamp: LATER,
    salary: 80000, goals: await getAll("goals"), buckets: await getAll("buckets"),
    bucketBalances: await bucketBalances(), completedAllocationToBucket: () => 0,
  });
  assert.equal(result, false);
  assert.deepEqual((await exportData()).data, before);
});

test("real ledger balances classify physical transfers, Cash Wallet, and virtual E.SUN allocations correctly", async () => {
  await reset();
  await bulkPut("transfers", [
    { id: "physical", status: "completed", fromAccountId: "ctbc", toAccountId: "esun",
      amount: 1200, transferType: "payday", budgetPeriodId: PERIOD_ID },
    { id: "atm", status: "completed", fromAccountId: "ctbc", toAccountId: "cash",
      amount: 800, transferType: "cash_withdrawal", budgetPeriodId: PERIOD_ID },
    { id: "virtual", status: "completed", fromAccountId: "esun", toAccountId: "esun",
      amount: 500, affectsPhysicalBalance: false, transferType: "bucket_allocation" },
    { id: "pending", status: "planned", fromAccountId: "ctbc", toAccountId: "esun",
      amount: 999, transferType: "payday" },
  ]);
  await bulkPut("transferAllocations", [
    { id: "v-em", transferId: "virtual", bucketId: "emergency", amount: 500 },
    { id: "t-em", transferId: "physical", bucketId: "emergency", amount: 1200 },
  ]);
  await put("expenses", { id: "cash-food", accountId: "cash", amount: 100, budgetPeriodId: PERIOD_ID });
  const b = await accountBalances(), virtual = await bucketBalances();
  assert.equal(b.ctbc, -2000);
  assert.equal(b.esun, 1200);
  assert.equal(b.cash, 700);
  assert.equal(virtual.emergency, 1700);
  assert.equal(b.ctbc + b.esun + b.cash, -100); // only actual spending changes physical net worth
});
