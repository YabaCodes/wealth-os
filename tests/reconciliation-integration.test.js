// v1.21.1 regression contract for reconciled bank roll-forward.
// Production Wealth views and db.wealthMetrics use these exact shared helpers.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  latestReconciliationFor, recordAfterReconciliation,
  physicalDeltaSinceReconciliation, accountSnapshotFor, esunSnapshotFor,
} from "../js/reconciliation.js";
import {
  clearStore, seedIfNeeded, getAll, getOne, put, bulkPut,
  accountBalances, bucketBalances, wealthMetrics, exportData,
} from "../js/db.js";

const STORES = [
  "accounts", "buckets", "categories", "goals", "periods", "incomes",
  "expenses", "transfers", "transferAllocations", "investmentSnapshots",
  "reconciliations", "adjustments", "monthlyCloses", "projects",
  "projectExpenses", "projectSettlements", "settings",
];
const CHECK_DATE = "2026-10-10";
const CHECK_STAMP = "2026-10-10T12:00:00.000Z";

async function reset() {
  for (const name of STORES) await clearStore(name);
  await seedIfNeeded();
}

function check(accountId = "ctbc", amount = 10000) {
  return {
    id: "check-" + accountId, accountId, date: CHECK_DATE, createdAt: CHECK_STAMP,
    actualBalance: amount,
  };
}
function blankLedgers() {
  return { incomes: [], expenses: [], transfers: [], adjustments: [] };
}
async function fromDb(accountId) {
  const [balances, reconciliations, incomes, expenses, transfers, adjustments, buckets, bb] = await Promise.all([
    accountBalances(), getAll("reconciliations"), getAll("incomes"), getAll("expenses"),
    getAll("transfers"), getAll("adjustments"), getAll("buckets"), bucketBalances(),
  ]);
  const snapshot = accountSnapshotFor(accountId, balances, reconciliations,
    { incomes, expenses, transfers, adjustments });
  return {
    snapshot,
    esun: accountId === "esun" ? esunSnapshotFor(snapshot, buckets, bb) : null,
    balances, bb,
  };
}

test("bank-check boundary includes only later effective dates, or later same-day recording timestamps", () => {
  const r = check();
  assert.equal(recordAfterReconciliation(r, "2026-10-09", "2026-10-11T19:00:00Z"), false);
  assert.equal(recordAfterReconciliation(r, "2026-10-11", "2026-10-09T00:00:00Z"), true);
  assert.equal(recordAfterReconciliation(r, CHECK_DATE, "2026-10-10T11:59:59Z"), false);
  assert.equal(recordAfterReconciliation(r, CHECK_DATE, CHECK_STAMP), false);
  assert.equal(recordAfterReconciliation(r, CHECK_DATE, "2026-10-10T12:00:01Z"), true);
  assert.equal(recordAfterReconciliation(r, CHECK_DATE, null), false);
});

test("latest reconciliation follows date and recorded timestamp; deleted checks are ignored", () => {
  const rows = [
    { ...check(), id: "newer", date: "2026-10-15", actualBalance: 11000 },
    { ...check(), id: "older", date: "2026-10-08", actualBalance: 9500 },
    { ...check(), id: "deleted", date: "2026-11-01", deletedAt: "2026-11-02" },
    { ...check(), id: "same-day-later", date: "2026-10-15",
      createdAt: "2026-10-15T20:00:00Z", actualBalance: 11250 },
  ];
  const before = structuredClone(rows);
  assert.equal(latestReconciliationFor(rows, "ctbc").id, "same-day-later");
  assert.equal(latestReconciliationFor(rows, "esun"), null);
  assert.deepEqual(rows, before);
});

test("physical delta filters deleted/prior/same-day records, pending transfers and virtual reallocations", () => {
  const r = check();
  const ledger = {
    incomes: [
      { id: "old", accountId: "ctbc", amount: 9000,
        dateReceived: "2026-10-09", createdAt: "2026-10-11T09:00:00Z" },
      { id: "new", accountId: "ctbc", amount: 3000,
        dateReceived: "2026-10-11", createdAt: "2026-10-11T09:00:00Z" },
      { id: "other", accountId: "esun", amount: 5000,
        dateReceived: "2026-10-11", createdAt: "2026-10-11T09:00:00Z" },
      { id: "deleted", accountId: "ctbc", amount: 5000,
        dateReceived: "2026-10-11", deletedAt: CHECK_STAMP },
    ],
    expenses: [
      { id: "before-check", accountId: "ctbc", amount: 800,
        date: CHECK_DATE, createdAt: "2026-10-10T11:00:00Z" },
      { id: "after-check", accountId: "ctbc", amount: 500,
        date: CHECK_DATE, createdAt: "2026-10-10T15:00:00Z" },
      { id: "deleted", accountId: "ctbc", amount: 300,
        date: "2026-10-11", deletedAt: CHECK_STAMP },
    ],
    transfers: [
      { id: "physical", status: "completed", fromAccountId: "ctbc", toAccountId: "esun",
        amount: 1200, completedDate: "2026-10-11", completedAt: "2026-10-11T10:00:00Z" },
      { id: "atm", status: "completed", fromAccountId: "ctbc", toAccountId: "cash",
        amount: 600, completedDate: "2026-10-11", completedAt: "2026-10-11T11:00:00Z" },
      { id: "planned", status: "planned", fromAccountId: "ctbc", toAccountId: "esun",
        amount: 1000, plannedDate: "2026-10-12" },
      { id: "virtual", status: "completed", fromAccountId: "esun", toAccountId: "esun",
        amount: 900, transferType: "purpose_reallocation",
        affectsPhysicalBalance: false, completedDate: "2026-10-12" },
      { id: "legacy-virtual", status: "completed", fromAccountId: "ctbc", toAccountId: "esun",
        amount: 700, transferType: "reserve_allocation", completedDate: "2026-10-12" },
      { id: "old", status: "completed", fromAccountId: "ctbc", toAccountId: "esun",
        amount: 400, completedDate: "2026-10-09" },
      { id: "deleted", status: "completed", fromAccountId: "ctbc", toAccountId: "esun",
        amount: 800, completedDate: "2026-10-12", deletedAt: CHECK_STAMP },
    ],
    adjustments: [
      { id: "before", accountId: "ctbc", amount: 200, date: CHECK_DATE,
        createdAt: "2026-10-10T09:00:00Z" },
      { id: "after", accountId: "ctbc", amount: 200, date: CHECK_DATE,
        createdAt: "2026-10-10T19:00:00Z" },
      { id: "deleted", accountId: "ctbc", amount: 500, date: "2026-10-12",
        deletedAt: CHECK_STAMP },
    ],
  };
  const saved = structuredClone(ledger);
  assert.equal(physicalDeltaSinceReconciliation("ctbc", r, ledger), 900);
  // +3,000 income -500 spend -1,200 bank -600 ATM +200 adjustment = +900.
  assert.equal(physicalDeltaSinceReconciliation("esun", r, ledger), 6200);
  assert.deepEqual(ledger, saved);
});

test("unreconciled account uses raw ledger; reconciled account uses the exact check as baseline", () => {
  const bankBalances = { ctbc: 22000 };
  const ledger = {
    ...blankLedgers(),
    incomes: [{ accountId: "ctbc", amount: 400, dateReceived: "2026-10-11" }],
  };
  const none = accountSnapshotFor("ctbc", bankBalances, [], ledger);
  assert.deepEqual(none, {
    accountId: "ctbc", expected: 22000, rawExpected: 22000, actual: 22000,
    difference: 0, verified: false, reconciliation: null,
    isEstimated: false, ledgerDeltaSinceCheck: 0,
  });
  const r = check("ctbc", 10000);
  const s = accountSnapshotFor("ctbc", bankBalances, [r], ledger);
  assert.equal(s.actual, 10400);
  assert.equal(s.rawExpected, 22000);
  assert.equal(s.verified, true);
  assert.equal(s.isEstimated, true);
  assert.equal(s.ledgerDeltaSinceCheck, 400);
});

test("persistent reconciliation roll-forward matches financial net worth and Cash Wallet after bank checks", async () => {
  await reset();
  await bulkPut("reconciliations", [
    check("ctbc", 10000),
    check("cash", 1000),
    check("esun", 5000),
  ]);
  await bulkPut("incomes", [
    { id: "precheck-income", accountId: "ctbc", amount: 20000,
      dateReceived: "2026-10-09", createdAt: "2026-10-09T09:00:00Z" },
    { id: "after-income", accountId: "ctbc", amount: 1500,
      dateReceived: "2026-10-11", createdAt: "2026-10-11T09:00:00Z" },
  ]);
  await bulkPut("expenses", [
    { id: "ctbc-food", accountId: "ctbc", amount: 400,
      date: "2026-10-11", createdAt: "2026-10-11T13:00:00Z" },
    { id: "cash-food", accountId: "cash", amount: 100,
      date: "2026-10-11", createdAt: "2026-10-11T13:00:00Z" },
  ]);
  await bulkPut("transfers", [
    { id: "ctbc-to-esun", fromAccountId: "ctbc", toAccountId: "esun", amount: 1200,
      status: "completed", completedDate: "2026-10-11", completedAt: "2026-10-11T14:00:00Z" },
    { id: "atm", fromAccountId: "ctbc", toAccountId: "cash", amount: 300,
      status: "completed", completedDate: "2026-10-11", completedAt: "2026-10-11T14:00:00Z" },
    { id: "esun-virtual", fromAccountId: "esun", toAccountId: "esun",
      amount: 5000, status: "completed", affectsPhysicalBalance: false,
      transferType: "bucket_allocation", completedDate: "2026-10-11" },
    { id: "pending", fromAccountId: "ctbc", toAccountId: "esun",
      amount: 800, status: "planned", plannedDate: "2026-10-11" },
  ]);
  await bulkPut("transferAllocations", [
    { id: "to-emergency", transferId: "esun-virtual", bucketId: "emergency", amount: 4000 },
    { id: "to-tithe", transferId: "esun-virtual", bucketId: "tithe", amount: 1000 },
  ]);
  await put("adjustments", { id: "ctbc-postcheck", accountId: "ctbc", amount: 50,
    date: "2026-10-11", createdAt: "2026-10-11T15:00:00Z" });
  const before = (await exportData()).data;
  const ct = await fromDb("ctbc");
  const cash = await fromDb("cash");
  const esun = await fromDb("esun");
  assert.equal(ct.snapshot.actual, 9650);
  assert.equal(ct.snapshot.ledgerDeltaSinceCheck, -350);
  assert.equal(cash.snapshot.actual, 1200);
  assert.equal(esun.snapshot.actual, 6200);
  assert.equal(esun.bb.emergency, 4000);
  assert.equal(esun.bb.tithe, 1000);
  assert.equal(esun.esun.virtualTotal, 5000);
  assert.equal(esun.esun.unassigned, 1200);
  assert.equal(esun.esun.allocationOk, false);
  assert.equal(esun.esun.bankOk, true);

  const metrics = await wealthMetrics();
  assert.equal(metrics.financialNetWorth, 9650 + 1200 + 4000);
  assert.equal(metrics.coreWealth, 4000);
  assert.equal(metrics.latestActual.ctbc, 10000);
  assert.equal(metrics.latestActual.cash, 1000);
  assert.deepEqual((await exportData()).data, before);
});

test("a newer bank check resets the roll-forward baseline without double counting older adjustments", async () => {
  await reset();
  await put("reconciliations", check("ctbc", 10000));
  await put("adjustments", {
    id: "old-adjustment", accountId: "ctbc", amount: 250,
    date: "2026-10-11", createdAt: "2026-10-11T12:00:00Z",
  });
  assert.equal((await fromDb("ctbc")).snapshot.actual, 10250);
  await put("reconciliations", {
    id: "new-check", accountId: "ctbc", date: "2026-10-12",
    createdAt: "2026-10-12T15:00:00Z", actualBalance: 10200,
  });
  assert.equal((await fromDb("ctbc")).snapshot.actual, 10200);
  await put("expenses", {
    id: "new-expense", accountId: "ctbc", amount: 350,
    date: "2026-10-13", createdAt: "2026-10-13T08:00:00Z",
  });
  assert.equal((await fromDb("ctbc")).snapshot.actual, 9850);
  assert.equal((await wealthMetrics()).financialNetWorth, 9850);
});

test("unassigned, exact and overallocated E.SUN buckets never create physical bank movements", async () => {
  await reset();
  await put("reconciliations", check("esun", 6000));
  await put("transfers", {
    id: "virtual", status: "completed", transferType: "bucket_allocation",
    affectsPhysicalBalance: false, fromAccountId: "esun", toAccountId: "esun", amount: 8000,
  });
  await put("transferAllocations", {
    id: "reserve", transferId: "virtual", bucketId: "emergency", amount: 5000,
  });
  let es = (await fromDb("esun")).esun;
  assert.equal(es.actual, 6000);
  assert.equal(es.virtualTotal, 5000);
  assert.equal(es.unassigned, 1000);
  assert.equal(es.allocationOk, false);
  await put("transferAllocations", { id: "tithe", transferId: "virtual", bucketId: "tithe", amount: 1000 });
  es = (await fromDb("esun")).esun;
  assert.equal(es.unassigned, 0);
  assert.equal(es.allocationOk, true);
  await put("transferAllocations", { id: "tithe", transferId: "virtual", bucketId: "tithe", amount: 4000 });
  es = (await fromDb("esun")).esun;
  assert.equal(es.unassigned, -3000);
  assert.equal(es.allocationOk, false);
  assert.equal((await accountBalances()).esun, 0);
});

test("reconciled baseline remains stable across offline-style fresh module reads", async () => {
  await reset();
  await put("reconciliations", check("ctbc", 5000));
  await put("expenses", {
    id: "after", accountId: "ctbc", amount: 100,
    date: "2026-10-11", createdAt: "2026-10-11T09:00:00Z",
  });
  const module = await import("../js/db.js?reconciliation-v1211-reopen");
  assert.equal((await module.wealthMetrics()).financialNetWorth, 4900);
  assert.equal((await fromDb("ctbc")).snapshot.actual, 4900);
});
