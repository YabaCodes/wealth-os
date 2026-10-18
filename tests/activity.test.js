import test from "node:test";
import assert from "node:assert/strict";
import {
  buildActivityRecords,
  filterActivityRecords,
  groupActivityByDay,
  dayHeading,
  isPurposeOnlyTransfer,
} from "../js/activity.js";

const categories = [
  { id: "food", name: "Food" },
  { id: "transport", name: "Transportation" },
];
const accounts = [
  { id: "ctbc", name: "CTBC Operating" },
  { id: "esun", name: "E.SUN Reserved" },
];
const incomeTypes = [
  ["regular_income", "Regular salary"],
  ["bonus", "Bonus"],
];

test("activity records normalize expenses, income and eligible transfers", () => {
  const rows = buildActivityRecords({
    expenses: [
      { id: "e1", date: "2026-10-18", categoryId: "food", accountId: "ctbc", amount: 250, description: "Lunch", createdAt: "3" },
      { id: "e2", date: "2026-10-18", categoryId: "food", accountId: "ctbc", amount: 999, deletedAt: "x" },
    ],
    incomes: [
      { id: "i1", dateReceived: "2026-10-17", incomeType: "bonus", accountId: "ctbc", amount: 1000, createdAt: "2" },
    ],
    transfers: [
      { id: "t1", completedDate: "2026-10-16", status: "completed", fromAccountId: "ctbc", toAccountId: "esun", amount: 500, createdAt: "1" },
      { id: "t2", plannedDate: "2026-10-19", status: "cancelled", fromAccountId: "ctbc", toAccountId: "esun", amount: 500 },
    ],
    categories,
    accounts,
    incomeTypes,
  });

  assert.deepEqual(rows.map((x) => x.id), ["e1", "i1", "t1"]);
  assert.equal(rows[0]._kind, "expense");
  assert.equal(rows[0]._amount, -250);
  assert.equal(rows[0]._title, "Food");
  assert.equal(rows[1]._title, "Bonus");
  assert.equal(rows[2]._title, "CTBC Operating → E.SUN Reserved");
  assert.equal(rows[2]._account, "Physical bank transfer");
});

test("purpose-only transfers remain virtual activity with zero spending impact wording", () => {
  assert.equal(isPurposeOnlyTransfer({ fromAccountId: "esun", toAccountId: "esun", transferType: "manual" }), true);
  assert.equal(isPurposeOnlyTransfer({ fromAccountId: "ctbc", toAccountId: "esun", transferType: "bucket_allocation" }), true);
  assert.equal(isPurposeOnlyTransfer({ fromAccountId: "ctbc", toAccountId: "esun", transferType: "manual" }), false);

  const [row] = buildActivityRecords({
    transfers: [
      { id: "t", plannedDate: "2026-10-18", status: "planned", fromAccountId: "esun", toAccountId: "esun", transferType: "purpose_reallocation", amount: 100 },
    ],
    accounts,
  });
  assert.equal(row._account, "Virtual purpose ledger");
  assert.match(row._detail, /bank impact NT\$0/);
});

test("activity filtering handles kind and free-text search", () => {
  const rows = buildActivityRecords({
    expenses: [
      { id: "e1", date: "2026-10-18", categoryId: "food", accountId: "ctbc", amount: 250, description: "Lunch" },
      { id: "e2", date: "2026-10-17", categoryId: "transport", accountId: "ctbc", amount: 80, description: "Train" },
    ],
    incomes: [
      { id: "i1", dateReceived: "2026-10-16", incomeType: "bonus", accountId: "ctbc", amount: 1000, description: "Performance" },
    ],
    categories,
    accounts,
    incomeTypes,
  });

  assert.deepEqual(filterActivityRecords(rows, { kind: "expense", query: "", categories }).map((x) => x.id), ["e1", "e2"]);
  assert.deepEqual(filterActivityRecords(rows, { kind: "all", query: "train", categories }).map((x) => x.id), ["e2"]);
  assert.deepEqual(filterActivityRecords(rows, { kind: "all", query: "bonus", categories }).map((x) => x.id), ["i1"]);
});

test("activity day grouping preserves order and calculates expense/income totals", () => {
  const grouped = groupActivityByDay([
    { id: "e1", _date: "2026-10-18", _kind: "expense", _amount: -250 },
    { id: "i1", _date: "2026-10-18", _kind: "income", _amount: 1000 },
    { id: "e2", _date: "2026-10-17", _kind: "expense", _amount: -80 },
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].key, "2026-10-18");
  assert.equal(grouped[0].spent, 250);
  assert.equal(grouped[0].earned, 1000);
  assert.equal(grouped[1].spent, 80);
});

test("activity day headings are deterministic for today, yesterday and older dates", () => {
  assert.equal(dayHeading("2026-10-18", "2026-10-18"), "Today");
  assert.equal(dayHeading("2026-10-17", "2026-10-18"), "Yesterday");
  assert.match(dayHeading("2025-10-17", "2026-10-18"), /2025/);
  assert.equal(dayHeading("", "2026-10-18"), "No date");
});
