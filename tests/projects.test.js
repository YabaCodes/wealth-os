import test from "node:test";
import assert from "node:assert/strict";
import {
  projectExpensesFor,
  projectKnownTwd,
  projectMissingTwd,
  projectOriginalTotals,
  projectPaymentTwd,
} from "../js/projects.js";

const rows = [
  { id: "a", projectId: "p1", date: "2026-10-01", createdAt: "1", originalAmount: 10, currency: "EUR", twdAmount: 350, paymentMethod: "method_a" },
  { id: "b", projectId: "p1", date: "2026-10-02", createdAt: "2", originalAmount: 5, currency: "EUR", twdAmount: null, paymentMethod: "method_b" },
  { id: "c", projectId: "p1", date: "2026-10-03", createdAt: "3", originalAmount: 100, currency: "TWD", twdAmount: 100, paymentMethod: "method_a" },
  { id: "d", projectId: "p1", date: "2026-10-04", createdAt: "4", originalAmount: 99, currency: "EUR", twdAmount: 999, paymentMethod: "method_a", deletedAt: "x" },
  { id: "e", projectId: "p2", date: "2026-10-05", createdAt: "5", originalAmount: 99, currency: "EUR", twdAmount: 999, paymentMethod: "method_a" },
];

test("project rows are filtered and sorted", () => {
  assert.deepEqual(projectExpensesFor(rows, "p1").map((x) => x.id), ["c", "b", "a"]);
});

test("project value and missing-value rules stay stable", () => {
  assert.equal(projectKnownTwd(rows, "p1"), 450);
  assert.deepEqual(projectMissingTwd(rows, "p1").map((x) => x.id), ["b"]);
});

test("project subtotals remain isolated by method and currency", () => {
  assert.equal(projectPaymentTwd(rows, "p1", "method_a"), 450);
  assert.deepEqual(projectOriginalTotals(rows, "p1"), { TWD: 100, EUR: 15 });
});
