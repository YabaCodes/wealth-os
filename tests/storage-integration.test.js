// Integration tests against Wealth OS's real js/db.js transactions and store layout.
// fake-indexeddb supplies an isolated in-memory implementation of the browser API;
// these are not substitutes for installed iPhone/Safari acceptance tests.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  seedIfNeeded,
  getAll,
  getOne,
  put,
  bulkPut,
  remove,
  clearStore,
  exportData,
  importData,
  validateBackup,
  backupSummary,
  saveUndoSnapshot,
  getUndoSnapshot,
  clearUndoSnapshot,
  accountBalances,
} from "../js/db.js";

const STORE_NAMES = [
  "accounts", "buckets", "categories", "goals", "periods", "incomes",
  "expenses", "transfers", "transferAllocations", "investmentSnapshots",
  "reconciliations", "adjustments", "monthlyCloses", "projects",
  "projectExpenses", "projectSettlements", "settings",
];

async function resetMainDatabase() {
  for (const store of STORE_NAMES) await clearStore(store);
  await seedIfNeeded();
}

test("first install creates every store and seeds only once without rewriting existing data", async () => {
  await resetMainDatabase();
  const initial = await exportData();
  assert.deepEqual(Object.keys(initial.data), STORE_NAMES);
  assert.ok(initial.data.accounts.length >= 2);
  assert.ok(initial.data.settings.some((row) => row.id === "app"));
  assert.equal((await getOne("settings", "app")).dataModelVersion, 190);

  await put("expenses", { id: "test-paid", accountId: "ctbc", amount: 99 });
  await seedIfNeeded();
  assert.deepEqual(await getOne("expenses", "test-paid"), {
    id: "test-paid", accountId: "ctbc", amount: 99,
  });
});

test("CRUD persists transaction commits, including after opening a fresh module instance", async () => {
  await resetMainDatabase();
  const a = { id: "month-a", status: "open" };
  const b = { id: "month-b", status: "closed" };
  await put("periods", a);
  await bulkPut("periods", [b, { ...a, status: "closed" }]);
  assert.deepEqual(await getOne("periods", "month-a"), { ...a, status: "closed" });
  assert.equal((await getAll("periods")).length, 2);

  // A new module instance creates a new IndexedDB connection to the same simulated origin.
  const reloaded = await import("../js/db.js?storage-reopen-v1200");
  assert.equal((await reloaded.getOne("periods", "month-b")).status, "closed");
  await remove("periods", "month-b");
  assert.equal(await getOne("periods", "month-b"), undefined);
  await clearStore("periods");
  assert.deepEqual(await getAll("periods"), []);
});

test("export and valid restore round-trip every store, replacing rather than duplicating records", async () => {
  await resetMainDatabase();
  await put("periods", { id: "2026-10", status: "closed" });
  await put("projects", { id: "trip-a", title: "Synthetic test trip", type: "business_trip" });
  await put("projectExpenses", {
    id: "trip-expense-a", projectId: "trip-a", categoryId: "food",
    reimbursementType: "flexible", twdAmount: 150,
  });
  await put("expenses", { id: "daily-a", accountId: "ctbc", amount: 200 });
  const backup = await exportData();
  assert.equal(backup.version, 1);
  assert.ok(backup.exportedAt);
  assert.equal(validateBackup(backup).ok, true);
  assert.equal(backupSummary(backup).expenses, 1);

  await put("expenses", { id: "extraneous-expense", accountId: "ctbc", amount: 10 });
  await remove("projects", "trip-a");
  await importData(backup);
  const restored = await exportData();
  assert.deepEqual(restored.data, backup.data);
  assert.equal(await getOne("expenses", "extraneous-expense"), undefined);
  assert.equal((await getOne("projects", "trip-a")).title, "Synthetic test trip");
});

test("invalid backup validation refuses restore without modifying any stored financial data", async () => {
  await resetMainDatabase();
  await put("expenses", { id: "keep-me", accountId: "ctbc", amount: 250 });
  const before = (await exportData()).data;
  const invalid = [
    { version: 3, data: before },
    { version: 1, data: { ...before, settings: [] } },
    { version: 1, data: { ...before, accounts: [] } },
    { version: 1, data: { ...before, expenses: { id: "broken" } } },
    { version: 1, data: { ...before, expenses: [{ amount: 100 }] } },
  ];
  for (const candidate of invalid) {
    assert.equal(validateBackup(candidate).ok, false);
    await assert.rejects(importData(candidate));
    assert.deepEqual((await exportData()).data, before);
  }
});

test("an uncloneable backup record aborts queued clear operations and preserves the entire database", async () => {
  await resetMainDatabase();
  await put("expenses", { id: "original-expense", accountId: "ctbc", amount: 725 });
  await put("projectExpenses", { id: "original-trip", projectId: "trip", twdAmount: 400 });
  const baseline = await exportData();
  const malformed = structuredClone(baseline);
  // Structurally valid but DataCloneError from IDBObjectStore.put; must abort transaction.
  malformed.data.expenses.push({ id: "bad-uncloneable", value: () => 123 });
  assert.equal(validateBackup(malformed).ok, true);
  await assert.rejects(importData(malformed), (err) => err?.name === "DataCloneError");
  assert.deepEqual((await exportData()).data, baseline.data);
});

test("pre-restore undo snapshot is independent of the main database and supports recovery", async () => {
  await resetMainDatabase();
  await clearUndoSnapshot();
  await put("expenses", { id: "old-expense", amount: 850, accountId: "ctbc" });
  const before = await exportData();
  const replacement = structuredClone(before);
  replacement.data.expenses = [{ id: "replacement-expense", amount: 40, accountId: "ctbc" }];
  await saveUndoSnapshot(before);
  await importData(replacement);

  assert.equal((await getOne("expenses", "replacement-expense")).amount, 40);
  const undo = await getUndoSnapshot();
  assert.ok(undo.savedAt);
  assert.deepEqual(undo.payload.data, before.data);
  await importData(undo.payload);
  assert.deepEqual((await exportData()).data, before.data);
  await clearUndoSnapshot();
  assert.equal(await getUndoSnapshot(), undefined);
});

test("only completed physical transfers move account balances; virtual allocations do not", async () => {
  await resetMainDatabase();
  await bulkPut("transfers", [
    { id: "physical", status: "completed", amount: 1200,
      fromAccountId: "ctbc", toAccountId: "esun" },
    { id: "virtual", status: "completed", amount: 600,
      fromAccountId: "ctbc", toAccountId: "esun", affectsPhysicalBalance: false },
    { id: "pending", status: "planned", amount: 900,
      fromAccountId: "ctbc", toAccountId: "esun" },
  ]);
  const balances = await accountBalances();
  assert.equal(balances.ctbc, -1200);
  assert.equal(balances.esun, 1200);
});
