import test from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_CATEGORIES,
  PROJECT_CURRENCIES,
  formatOriginal,
  projectExpensesFor,
  projectKnownTwd,
  projectMissingTwd,
  projectOriginalTotals,
  projectPaymentTwd,
} from "../js/projects.js";

const rows = [
  {
    id: "a",
    projectId: "trip",
    date: "2026-10-17",
    createdAt: "2026-10-17T10:00:00Z",
    originalAmount: 25,
    currency: "EUR",
    twdAmount: 880,
    paymentMethod: "esun_card",
  },
  {
    id: "b",
    projectId: "trip",
    date: "2026-10-18",
    createdAt: "2026-10-18T10:00:00Z",
    originalAmount: 10.5,
    currency: "EUR",
    twdAmount: null,
    paymentMethod: "cash",
  },
  {
    id: "c",
    projectId: "trip",
    date: "2026-10-18",
    createdAt: "2026-10-18T11:00:00Z",
    originalAmount: 500,
    currency: "TWD",
    twdAmount: 500,
    paymentMethod: "esun_card",
  },
  {
    id: "deleted",
    projectId: "trip",
    date: "2026-10-19",
    originalAmount: 999,
    currency: "EUR",
    twdAmount: 99999,
    paymentMethod: "esun_card",
    deletedAt: "2026-10-20T00:00:00Z",
  },
  {
    id: "other",
    projectId: "other-project",
    date: "2026-10-18",
    originalAmount: 100,
    currency: "EUR",
    twdAmount: 3500,
    paymentMethod: "esun_card",
  },
];

test("project constants preserve the supported capture choices", () => {
  assert.deepEqual(PROJECT_CURRENCIES, ["EUR", "TWD", "USD", "GBP", "CHF", "JPY"]);
  assert.ok(PROJECT_CATEGORIES.includes("Hotel"));
  assert.ok(PROJECT_CATEGORIES.includes("Car Rental"));
  assert.ok(PROJECT_CATEGORIES.includes("Food"));
});

test("project expense selection excludes deleted and other-project rows and keeps newest first", () => {
  const selected = projectExpensesFor(rows, "trip");
  assert.deepEqual(selected.map((x) => x.id), ["c", "b", "a"]);
});

test("known NTD total includes only finite values from live rows", () => {
  assert.equal(projectKnownTwd(rows, "trip"), 1380);
});

test("missing NTD identifies expenses that still block settlement", () => {
  assert.deepEqual(projectMissingTwd(rows, "trip").map((x) => x.id), ["b"]);
});

test("payment-method subtotal isolates E.SUN-card project spending", () => {
  assert.equal(projectPaymentTwd(rows, "trip", "esun_card"), 1380);
  assert.equal(projectPaymentTwd(rows, "trip", "cash"), 0);
});

test("original-currency totals remain separate", () => {
  assert.deepEqual(projectOriginalTotals(rows, "trip"), { TWD: 500, EUR: 35.5 });
});

test("original amount formatting preserves currency and decimal precision", () => {
  assert.match(formatOriginal(10.5, "EUR"), /^EUR\s/);
  assert.match(formatOriginal(10.5, "EUR"), /10[.,]50$/);
  assert.match(formatOriginal(500, "TWD"), /^TWD\s/);
});
