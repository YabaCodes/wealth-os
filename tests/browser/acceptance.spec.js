import { test, expect } from "@playwright/test";
import {
  seedSyntheticBrowser, readBrowserStore, syntheticPeriod,
  testTrip, trainExpense, pendingDeposit,
} from "./fixtures.mjs";

test("navigation, Settings release identity and actual expense form persist through reload", async ({ page }) => {
  await seedSyntheticBrowser(page);
  await page.locator('[data-action="settings"]').first().click();
  await expect(page.locator('[role="dialog"]')).toContainText("Wealth OS v1.21.2");
  await expect(page.locator('[role="dialog"]')).toContainText("Data model 190");
  await page.locator('[data-action="close-modal"]').click();

  await page.locator('[data-tab="budget"]').click();
  await expect(page.locator(".topbar h1")).toHaveText("Budget");
  await page.locator('[data-tab="transactions"]').click();
  await expect(page.locator(".topbar h1")).toHaveText("Activity");
  await page.locator('[data-tab="wealth"]').click();
  await expect(page.locator(".topbar h1")).toHaveText("Wealth");
  await page.locator('[data-tab="home"]').click();

  await page.locator('[data-action="new-entry"]').first().click();
  await expect(page.locator("#expense-form")).toBeVisible();
  await expect(page.locator('#expense-form input[name="category"]:checked')).toHaveValue("food");
  await page.locator('#expense-form input[name="amount"]').fill("125");
  await page.locator('#expense-form input[name="description"]').fill("Browser test lunch");
  await page.locator('#expense-form button.btn').last().click();
  await expect(page.locator("#expense-form")).toHaveCount(0);
  await expect.poll(async () => (await readBrowserStore(page, "expenses")).length).toBe(1);
  const entries = await readBrowserStore(page, "expenses");
  expect(entries[0]).toMatchObject({
    amount: 125, categoryId: "food", budgetPeriodId: "2026-10", accountId: "ctbc",
    description: "Browser test lunch",
  });
  await page.reload();
  await page.locator('[data-tab="transactions"]').click();
  await expect(page.locator(".tx")).toContainText(["Browser test lunch"]);
});

test("closed funding month is read-only from expense form and close review", async ({ page }) => {
  await seedSyntheticBrowser(page, { closedPrior: true });
  await page.locator('[data-tab="budget"]').click();
  await page.locator("#period-select").selectOption("2026-09");
  await expect(page.locator(".period-current")).toContainText("Closed");
  await page.locator('[data-action="add-expense"]').first().click();
  await expect(page.locator('[role="dialog"]')).toContainText("is closed");
  await expect(page.locator("#expense-form")).toHaveCount(0);
  await page.locator('[data-action="close-modal"]').click();

  await page.locator('[data-action="month-close"]').first().click();
  await expect(page.locator('[role="dialog"]')).toContainText("Saved month-end snapshot");
  await expect(page.locator('[role="dialog"]')).toContainText("Locked");
  const periods = await readBrowserStore(page, "periods");
  expect(periods.find((p) => p.id === "2026-09").state).toBe("closed");
  expect((await readBrowserStore(page, "monthlyCloses")).find((c) => c.id === "2026-09").expenses).toBe(900);
});

test("month-end review closes a ready synthetic month and keeps audit snapshot across re-open", async ({ page }) => {
  await seedSyntheticBrowser(page, { readyToClose: true });
  await page.locator('[data-action="month-close"]').first().click();
  await expect(page.locator('[role="dialog"]')).toContainText("Ready to save the month-end snapshot");
  await page.locator('[data-action="close-period"]').click();
  await expect.poll(async () =>
    (await readBrowserStore(page, "periods")).find((p) => p.id === "2026-10")?.state,
  ).toBe("closed");
  const frozen = (await readBrowserStore(page, "monthlyCloses")).find((c) => c.id === "2026-10");
  expect(frozen).toMatchObject({ status: "closed", snapshotVersion: 1, id: "2026-10", expenses: 0 });
  await page.reload();
  await page.locator('[data-action="month-close"]').first().click();
  await expect(page.locator('[role="dialog"]')).toContainText("Saved month-end snapshot");
  await page.locator('[data-action="reopen-period"]').first().click();
  await expect.poll(async () =>
    (await readBrowserStore(page, "periods")).find((p) => p.id === "2026-10")?.state,
  ).toBe("reopened");
  const reopened = (await readBrowserStore(page, "monthlyCloses")).find((c) => c.id === "2026-10");
  expect(reopened).toMatchObject({ status: "reopened", expenses: 0, endingCoreWealth: frozen.endingCoreWealth });
});

test("pending deposit disables Business Trip settlement and new entry defaults to Food", async ({ page }) => {
  await seedSyntheticBrowser(page, { trip: testTrip(), expenses: [trainExpense(), pendingDeposit()] });
  await page.locator('[data-action="open-projects"]').first().click();
  await page.locator('[data-action="open-project"][data-id="synthetic-trip"]').click();
  await expect(page.locator('[role="dialog"]')).toContainText("Synthetic Browser Test Trip");
  await expect(page.locator('[role="dialog"]')).toContainText("refund status");
  await expect(page.locator('[data-action="settle-project"]')).toBeDisabled();
  await page.locator('[data-action="add-project-expense"]').first().click();
  await expect(page.locator("#project-expense-form")).toBeVisible();
  await expect(page.locator('#project-expense-form select[name="categoryId"]')).toHaveValue("food");
  await page.locator('[data-action="close-modal"]').click();
  const settlements = await readBrowserStore(page, "projectSettlements");
  expect(settlements).toHaveLength(0);
});

test("actual Business Trip settlement saves once and Undo removes generated surplus", async ({ page }) => {
  await seedSyntheticBrowser(page, { trip: testTrip(), expenses: [trainExpense()] });
  await page.locator('[data-action="open-projects"]').first().click();
  await page.locator('[data-action="open-project"][data-id="synthetic-trip"]').click();
  await page.locator('[data-action="settle-project"]').click();
  await expect(page.locator("#project-settlement-form")).toBeVisible();
  await expect(page.locator("#project-settlement-form")).toContainText("Fixed allowance");
  await page.locator('#project-settlement-form input[name="reimbursementTwd"]').fill("45500");
  await page.locator('#project-settlement-form select[name="surplusRoute"]').selectOption("keep");
  await page.locator('#project-settlement-form button.btn').last().click();
  await expect.poll(async () => (await readBrowserStore(page, "projectSettlements")).length).toBe(1);
  const settlements = await readBrowserStore(page, "projectSettlements");
  expect(settlements[0]).toMatchObject({
    projectId: "synthetic-trip",
    totalProjectCostTwd: 3500, reimbursementTwd: 45500,
    differenceTwd: 42000, exactReimbursableTwd: 3500, flexibleAllowanceTwd: 42000,
  });
  const incomes = await readBrowserStore(page, "incomes");
  expect(incomes).toHaveLength(1);
  expect(incomes[0]).toMatchObject({ amount: 42000, sourceProjectId: "synthetic-trip" });
  expect(await readBrowserStore(page, "expenses")).toHaveLength(0);
  await expect(page.locator('[data-action="undo-project-settlement"]')).toBeVisible();
  // Do not alter project expense history when undoing the generated personal ledger.
  await page.locator('[data-action="undo-project-settlement"]').click();
  await expect(page.getByRole("button", { name: "Undo settlement", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo settlement", exact: true }).click();
  await expect.poll(async () => (await readBrowserStore(page, "projectSettlements")).length).toBe(0);
  expect(await readBrowserStore(page, "incomes")).toHaveLength(0);
  expect(await readBrowserStore(page, "projectExpenses")).toHaveLength(1);
});

test("invalid backup through actual Restore control does not replace local data", async ({ page }) => {
  await seedSyntheticBrowser(page, { period: syntheticPeriod() });
  await page.locator('[data-action="settings"]').first().click();
  await expect(page.locator("#restore-file")).toHaveCount(1);
  const before = await readBrowserStore(page, "periods");
  await page.locator("#restore-file").setInputFiles({
    name: "broken-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"not":"a wealth os backup"}'),
  });
  await expect(page.locator("body")).toContainText("Couldn't restore that backup");
  expect(await readBrowserStore(page, "periods")).toEqual(before);
});
