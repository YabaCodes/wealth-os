import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  seedSyntheticBrowser, readBrowserStore, syntheticPeriod,
  testTrip, trainExpense, pendingDeposit,
} from "./fixtures.mjs";

test("navigation, Settings release identity and actual expense form persist through reload", async ({ page }) => {
  await seedSyntheticBrowser(page);
  await page.locator('[data-action="settings"]').first().click();
  await expect(page.locator('[role="dialog"]')).toContainText("Wealth OS v1.23.2");
  await expect(page.locator('[role="dialog"]')).toContainText("Data model 190");
  await page.locator('[data-action="close-modal"]').click();

  await page.locator('[data-tab="budget"]').click();
  await expect(page.locator(".topbar h1")).toHaveText("Budget");
  await page.locator('nav [data-tab="transactions"]').click();
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
  await page.locator('nav [data-tab="transactions"]').click();
  await expect(page.locator(".tx")).toContainText(["Browser test lunch"]);
});

test("closed funding month is read-only from expense form and close review", async ({ page }) => {
  await seedSyntheticBrowser(page, { closedPrior: true });
  await page.locator('[data-tab="budget"]').click();
  await page.locator("#period-select").selectOption("2026-09");
  await expect(page.locator(".period-current")).toContainText("Closed");
  // The app intentionally routes global + entry capture to a different open month.
  // Read-only enforcement is verified from the actual selected month's close review.
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
  await page.locator('[role="dialog"] [data-action="reopen-period"]').click();
  await expect.poll(async () =>
    (await readBrowserStore(page, "periods")).find((p) => p.id === "2026-10")?.state,
  ).toBe("reopened");
  const reopened = (await readBrowserStore(page, "monthlyCloses")).find((c) => c.id === "2026-10");
  expect(reopened).toMatchObject({ status: "reopened", expenses: 0, endingCoreWealth: frozen.endingCoreWealth });
});

test("pending deposit disables Business Trip settlement and new entry defaults to Food", async ({ page }) => {
  await seedSyntheticBrowser(page, { trip: testTrip(), expenses: [trainExpense(), pendingDeposit()] });
  await page.locator('nav [data-tab="transactions"]').click();
  await page.locator('[data-action="open-projects"]').first().click();
  await page.locator('[role="dialog"] [data-action="open-project"][data-id="synthetic-trip"]').click();
  await expect(page.locator('[role="dialog"]')).toContainText("Synthetic Browser Test Trip");
  await expect(page.locator('[role="dialog"]')).toContainText("refund status");
  await expect(page.locator('[data-action="settle-project"]')).toBeDisabled();
  await page.locator('[role="dialog"] [data-action="add-project-expense"]').click();
  await expect(page.locator("#project-expense-form")).toBeVisible();
  await expect(page.locator('#project-expense-form select[name="categoryId"]')).toHaveValue("food");
  await page.locator('[data-action="close-modal"]').click();
  const settlements = await readBrowserStore(page, "projectSettlements");
  expect(settlements).toHaveLength(0);
});

test("actual Business Trip settlement saves once and Undo removes generated surplus", async ({ page }) => {
  await seedSyntheticBrowser(page, { trip: testTrip(), expenses: [trainExpense()] });
  await page.locator('nav [data-tab="transactions"]').click();
  await page.locator('[data-action="open-projects"]').first().click();
  await page.locator('[role="dialog"] [data-action="open-project"][data-id="synthetic-trip"]').click();
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

test("Export Backup downloads valid JSON and a restore preview can be safely cancelled", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "chromium-mobile", "Mobile share sheet is covered by physical iPhone acceptance");
  await seedSyntheticBrowser(page);
  await page.locator('[data-action="settings"]').first().click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator('[role="dialog"] [data-action="export-backup"]').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^wealth-os-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const payload = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(payload.version).toBe(1);
  expect(payload.data.periods).toHaveLength(1);
  expect(payload.data.periods[0].id).toBe("2026-10");
  const before = await readBrowserStore(page, "periods");

  await page.locator("#restore-file").setInputFiles({
    name: "valid-synthetic-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(payload)),
  });
  await expect(page.locator(".ask-sheet")).toContainText("Replace all data with this backup?");
  await page.locator("#ask-cancel").click();
  expect(await readBrowserStore(page, "periods")).toEqual(before);
});

test("Goals what-if preview responds to inputs and never writes financial records", async ({ page }) => {
  await seedSyntheticBrowser(page);
  await page.locator('nav [data-tab="wealth"]').click();
  await page.locator('.wealth-switch [data-tab="goals"]').click();
  await expect(page.locator("#goal-scenario-planner")).toBeVisible();
  await expect(page.locator("#goal-scenario-select")).toHaveValue("goal-emergency");
  await expect(page.locator("#goal-scenario-result")).toContainText("No recorded monthly contributions");

  const before = await page.evaluate(async () => (await import("/js/db.js")).exportData());
  await page.locator("#goal-scenario-extra").fill("10000");
  await expect(page.locator(".goal-scenario-highlight")).not.toContainText("No estimate");
  await expect(page.locator("#goal-scenario-result")).toContainText("No recorded funding pace yet");

  await page.locator("#goal-scenario-select").selectOption("goal-home-trip");
  await expect(page.locator("#goal-scenario-result")).toContainText("waiting for Emergency Fund");
  await expect(page.locator(".goal-scenario-highlight")).toContainText("No estimate");

  await page.locator("#goal-scenario-select").selectOption("goal-equipment");
  await expect(page.locator("#goal-scenario-result")).toContainText("paused");
  await expect(page.locator(".goal-scenario-highlight")).toContainText("No estimate");

  const after = await page.evaluate(async () => (await import("/js/db.js")).exportData());
  // Export timestamps differ; the financial stores and settings are identical.
  expect(after.data).toEqual(before.data);

  await page.reload();
  await page.locator('nav [data-tab="wealth"]').click();
  await page.locator('.wealth-switch [data-tab="goals"]').click();
  await expect(page.locator("#goal-scenario-extra")).toHaveValue("0");
});

test("Goals what-if uses completed allocations and restores private-money masking", async ({ page }) => {
  await seedSyntheticBrowser(page);
  await page.evaluate(async () => {
    const db = await import("/js/db.js");
    await db.put("periods", {
      id: "2026-09", state: "funded",
      planSnapshot: { salary: 0, fixed: 0, caps: 0, sinking: 0, buffer: 0, immediateWealth: 0, lines: [] },
    });
    await db.put("transfers", {
      id: "completed-emergency", status: "completed", transferType: "purpose_reallocation",
      affectsPhysicalBalance: false, fromAccountId: "esun", toAccountId: "esun",
      budgetPeriodId: "2026-10", amount: 12000, completedDate: "2026-10-18",
    });
    await db.put("transferAllocations", {
      id: "actual-emergency", transferId: "completed-emergency",
      bucketId: "emergency", goalId: "goal-emergency", amount: 12000,
    });
  });
  await page.reload();
  await page.locator('nav [data-tab="wealth"]').click();
  await page.locator('.wealth-switch [data-tab="goals"]').click();
  await expect(page.locator("#goal-scenario-result")).toContainText("NT$6,000");
  await page.locator("#goal-scenario-extra").fill("10000");
  await expect(page.locator("#goal-scenario-result")).toContainText("NT$16,000");

  await page.locator('[data-action="privacy-toggle"]').click();
  await expect(page.locator("#goal-scenario-result")).not.toContainText("NT$16,000");
  await expect(page.locator("#goal-scenario-result")).toContainText("••••");
  await page.locator("#goal-scenario-extra").fill("20000");
  await expect(page.locator("#goal-scenario-result")).not.toContainText("NT$26,000");
  await expect(page.locator("#goal-scenario-result")).toContainText("••••");
});

test("Goals planner ETA and labels pass contrast checks in explicit Light, Dark and system Dark", async ({ page }) => {
  await seedSyntheticBrowser(page);
  const goToPlanner = async () => {
    await page.locator('nav [data-tab="wealth"]').click();
    await page.locator('.wealth-switch [data-tab="goals"]').click();
    await expect(page.locator(".goal-scenario-highlight strong")).toBeVisible();
  };
  const setTheme = async (theme) => {
    await page.locator('[data-action="settings"]').first().click();
    await page.locator(`[role="dialog"] [data-action="set-theme"][data-theme="${theme}"]`).click();
    await page.locator('[role="dialog"] [data-action="close-modal"]').first().click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "system" ? "dark" : theme);
  };
  const check = async () => page.evaluate(() => {
    const rgb = (color) => {
      const numbers = color.match(/[0-9.]+/g).slice(0, 3).map(Number);
      return numbers.map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
    };
    const luminance = (color) => rgb(color).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
    const contrast = (a, b) => {
      const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const highlight = document.querySelector(".goal-scenario-highlight");
    const label = highlight.querySelector(".metric-label");
    const value = highlight.querySelector("strong");
    const card = document.querySelector("#goal-scenario-planner");
    const message = card.querySelector(".goal-scenario-message");
    const disclaimer = card.querySelector(".goal-scenario-disclaimer");
    const bg = getComputedStyle(highlight).backgroundColor;
    const cardBg = getComputedStyle(card).backgroundColor;
    return {
      background: bg,
      theme: document.documentElement.dataset.theme,
      label: contrast(getComputedStyle(label).color, bg),
      value: contrast(getComputedStyle(value).color, bg),
      message: contrast(getComputedStyle(message).color, cardBg),
      disclaimer: contrast(getComputedStyle(disclaimer).color, cardBg),
    };
  });
  await goToPlanner();
  await page.locator("#goal-scenario-extra").fill("10000");
  const light = await check();
  expect(light.theme).toBe("light");
  for (const part of ["label", "value", "message", "disclaimer"])
    expect(light[part], `light theme ${part}`).toBeGreaterThanOrEqual(4.5);

  await setTheme("dark");
  const dark = await check();
  expect(dark.background).not.toBe(light.background);
  for (const part of ["label", "value", "message", "disclaimer"])
    expect(dark[part], `dark theme ${part}`).toBeGreaterThanOrEqual(4.5);
  await page.locator("#goal-scenario-extra").fill("20000");
  await expect(page.locator(".goal-scenario-highlight strong")).not.toContainText("No estimate");
  const afterUpdate = await check();
  expect(afterUpdate.value).toBeGreaterThanOrEqual(4.5);

  await setTheme("light");
  expect((await check()).background).toBe(light.background);
  await page.emulateMedia({ colorScheme: "dark" });
  await setTheme("system");
  const systemDark = await check();
  expect(systemDark.background).toBe(dark.background);
  expect(systemDark.label).toBeGreaterThanOrEqual(4.5);
  expect(systemDark.value).toBeGreaterThanOrEqual(4.5);
});

test("Target-date Goals planner computes month-end requirements, flags budget gaps and writes no records", async ({ page }) => {
  await seedSyntheticBrowser(page);
  await page.evaluate(async () => {
    const db = await import("/js/db.js");
    const p = await db.getOne("periods", "2026-10");
    await db.put("periods", { ...p, planSnapshot: {
      ...p.planSnapshot, salary: 90000, immediateWealth: 50000,
    } });
    await db.put("transferAllocations", {
      id: "funded-target-alloc", transferId: "funded-target-transfer",
      bucketId: "emergency", amount: 12000,
    });
    await db.put("transfers", {
      id: "funded-target-transfer", status: "completed",
      affectsPhysicalBalance: false, transferType: "purpose_reallocation",
      fromAccountId: "esun", toAccountId: "esun", amount: 12000,
      budgetPeriodId: "2026-10", completedDate: "2026-10-19",
    });
  });
  await page.reload();
  await page.locator('nav [data-tab="wealth"]').click();
  await page.locator('.wealth-switch [data-tab="goals"]').click();
  const before = await page.evaluate(async () => (await import("/js/db.js")).exportData());
  await page.locator('[data-goal-scenario-mode="date"]').click();
  await expect(page.locator("#goal-scenario-deadline")).toBeVisible();
  await expect(page.locator("#goal-scenario-extra")).toBeHidden();
  await page.locator("#goal-scenario-deadline").fill("2027-03-31");
  await expect(page.locator("#goal-scenario-result")).toContainText("Required each month");
  await expect(page.locator(".goal-scenario-highlight")).toContainText("NT$");
  await expect(page.locator(".goal-target-feasibility")).toContainText("Above current planned wealth funding");
  await expect(page.locator("#goal-scenario-result")).toContainText("5");
  await page.locator("#goal-scenario-deadline").fill("2027-04-30");
  await expect(page.locator(".goal-target-feasibility")).toContainText("Within planned wealth funding");
  await page.locator("#goal-scenario-deadline").fill("2026-11-01");
  await expect(page.locator("#goal-scenario-result")).toContainText("There are no full future month-end contributions");
  await page.locator("#goal-scenario-select").selectOption("goal-home-trip");
  await expect(page.locator("#goal-scenario-result")).toContainText("waiting for Emergency Fund");
  await expect(page.locator(".goal-scenario-highlight")).toContainText("No estimate");
  await page.locator("#goal-scenario-select").selectOption("goal-equipment");
  await expect(page.locator("#goal-scenario-result")).toContainText("paused");

  await page.locator('[data-goal-scenario-mode="extra"]').click();
  await expect(page.locator("#goal-scenario-deadline")).toBeHidden();
  await expect(page.locator("#goal-scenario-extra")).toBeVisible();
  const after = await page.evaluate(async () => (await import("/js/db.js")).exportData());
  expect(after.data).toEqual(before.data);
  await page.reload();
  await page.locator('nav [data-tab="wealth"]').click();
  await page.locator('.wealth-switch [data-tab="goals"]').click();
  await expect(page.locator('[data-goal-scenario-mode="extra"]')).toHaveAttribute("aria-pressed", "true");
});

test("Target-date capacity unknown and privacy remain readable in dark mode", async ({ page }) => {
  await seedSyntheticBrowser(page);
  await page.locator('nav [data-tab="wealth"]').click();
  await page.locator('.wealth-switch [data-tab="goals"]').click();
  await page.locator('[data-goal-scenario-mode="date"]').click();
  await page.locator("#goal-scenario-deadline").fill("2027-03-31");
  await expect(page.locator(".goal-target-feasibility")).toContainText("Budget capacity unknown");
  await page.locator('[data-action="settings"]').first().click();
  await page.locator('[role="dialog"] [data-action="set-theme"][data-theme="dark"]').click();
  await page.locator('[role="dialog"] [data-action="close-modal"]').first().click();
  await expect(page.locator(".goal-scenario-highlight strong")).toBeVisible();
  await page.locator('[data-action="privacy-toggle"]').click();
  // Toggling privacy redraws the page and resets ephemeral planner mode.
  await page.locator('[data-goal-scenario-mode="date"]').click();
  await page.locator("#goal-scenario-deadline").fill("2027-03-31");
  await expect(page.locator(".goal-scenario-highlight strong")).toContainText("••••");
  await page.locator("#goal-scenario-deadline").fill("2027-05-31");
  await expect(page.locator(".goal-scenario-highlight strong")).toContainText("••••");
  const styles = await page.evaluate(() => {
    const el = document.querySelector(".goal-target-feasibility");
    return { bg: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color };
  });
  expect(styles.bg).not.toBe(styles.text);
});

test("Goals portfolio shows priorities, saved deadline health, shared capacity and opens planner without writes", async ({ page }) => {
  await seedSyntheticBrowser(page);
  await page.evaluate(async () => {
    const db = await import("/js/db.js");
    const goals = await db.getAll("goals");
    const emergency = goals.find((g) => g.id === "goal-emergency");
    await db.put("goals", { ...emergency, targetDate: "2027-03-31" });
    const p = await db.getOne("periods", "2026-10");
    await db.put("periods", { ...p, planSnapshot: {
      ...p.planSnapshot, salary: 90000, immediateWealth: 5000,
    } });
  });
  await page.reload();
  await page.locator('nav [data-tab="wealth"]').click();
  await page.locator('.wealth-switch [data-tab="goals"]').click();
  await expect(page.locator("#goals-portfolio")).toBeVisible();
  await expect(page.locator('[data-portfolio-focus="goal-emergency"]')).toContainText("Emergency Fund");
  await expect(page.locator('[data-portfolio-focus="goal-emergency"]')).toContainText("No recorded pace");
  await expect(page.locator("#goals-portfolio")).toContainText("Home Travel");
  await expect(page.locator("#goals-portfolio")).toContainText("Waiting");
  await expect(page.locator("#goals-portfolio")).toContainText("Equipment");
  await expect(page.locator("#goals-portfolio")).toContainText("Paused");
  await expect(page.locator(".goal-portfolio-shared")).toContainText("One shared funding plan");
  await expect(page.locator(".goal-portfolio-shared")).toContainText("exceeding the shared plan");
  const before = await page.evaluate(async () => (await import("/js/db.js")).exportData());
  await page.locator('[data-portfolio-focus="goal-emergency"] [data-portfolio-plan]').click();
  await expect(page.locator("#goal-scenario-select")).toHaveValue("goal-emergency");
  await expect(page.locator('[data-goal-scenario-mode="date"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#goal-scenario-deadline")).toHaveValue("2027-03-31");
  await page.locator('[data-portfolio-goal="goal-home-trip"] [data-portfolio-plan]').click();
  await expect(page.locator("#goal-scenario-select")).toHaveValue("goal-home-trip");
  await expect(page.locator("#goal-scenario-result")).toContainText("waiting for Emergency Fund");
  const after = await page.evaluate(async () => (await import("/js/db.js")).exportData());
  expect(after.data).toEqual(before.data);
});

test("Goals portfolio uses dark-mode readable labels and masks saved money in privacy mode", async ({ page }) => {
  await seedSyntheticBrowser(page);
  await page.locator('nav [data-tab="wealth"]').click();
  await page.locator('.wealth-switch [data-tab="goals"]').click();
  await expect(page.locator("#goals-portfolio")).toBeVisible();
  await expect(page.locator(".goal-portfolio-shared")).toContainText("No active goals have usable deadlines");
  await page.locator('[data-action="settings"]').first().click();
  await page.locator('[role="dialog"] [data-action="set-theme"][data-theme="dark"]').click();
  await page.locator('[role="dialog"] [data-action="close-modal"]').first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme","dark");
  await expect(page.locator(".goal-portfolio-health").first()).toBeVisible();
  await page.locator('[data-action="privacy-toggle"]').click();
  await expect(page.locator("#goals-portfolio")).toContainText("••••");
  await expect(page.locator("#goals-portfolio")).not.toContainText("NT$300,000");
  const sizes = await page.evaluate(() => {
    const box = document.querySelector("#goals-portfolio").getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    return { right: box.right, width };
  });
  expect(sizes.right).toBeLessThanOrEqual(sizes.width + 1);
});

test("Monthly Financial Review reuses personal spending and comparison without writes", async ({ page }) => {
  await seedSyntheticBrowser(page, { closedPrior: true, trip: testTrip(), expenses: [trainExpense()] });
  await page.evaluate(async () => {
    const db = await import("/js/db.js");
    const p = await db.getOne("periods", "2026-10");
    await db.put("periods", { ...p, planSnapshot: {
      ...p.planSnapshot, salary: 82000, immediateWealth: 10000,
      fixed: 23000, caps: 8500,
      lines: [
        { id: "rent", name: "Rent", ruleType: "fixed", budgetAmount: 23000 },
        { id: "food", name: "Food", ruleType: "cap", budgetAmount: 8500 },
      ],
    }});
    await db.put("expenses", {
      id: "monthly-review-food", categoryId: "food", amount: 1500,
      budgetPeriodId: "2026-10", accountId: "ctbc", date: "2026-10-19",
      description: "Synthetic lunch",
    });
  });
  await page.reload();
  const before = await page.evaluate(async () => (await import("/js/db.js")).exportData());
  await page.locator('[data-action="monthly-review"]').first().click();
  const review = page.locator("#monthly-review");
  await expect(review).toBeVisible();
  await expect(review).toContainText("October 2026");
  await expect(review).toContainText("Personal expenses");
  await expect(review).toContainText("NT$1,500");
  await expect(review).toContainText("Tracked fixed + flexible plan");
  await expect(review).toContainText("NT$31,500");
  await expect(review).toContainText("Compared with previous recorded month");
  await expect(review).toContainText("September 2026");
  await expect(review).toContainText("Core wealth funded");
  await expect(review).toContainText("Close readiness and bank checks");
  await expect(review).toContainText("Month-End Review");
  // Synthetic business-trip expense is NOT personal spending.
  await expect(review.locator(".mr-metrics").first()).not.toContainText("NT$3,500");
  const after = await page.evaluate(async () => (await import("/js/db.js")).exportData());
  expect(after.data).toEqual(before.data);
  await review.locator('[data-action="review-nav"][data-tab="transactions"]').first().click();
  await expect(page.locator(".topbar h1")).toHaveText("Activity");
  await expect(page.locator("#monthly-review")).toHaveCount(0);
  await page.locator('nav [data-tab="budget"]').click();
  await page.locator('.mr-budget-entry [data-action="monthly-review"]').click();
  await expect(page.locator("#monthly-review")).toBeVisible();
  await page.locator('#monthly-review .mr-navigation [data-action="month-close"]').click();
  await expect(page.locator('[role="dialog"]')).toContainText("Month-End Review");
  // A review shortcut opens the existing close preview; it does not close the month.
  expect((await readBrowserStore(page, "periods")).find((x) => x.id === "2026-10").state).toBe("funded");
});

test("Closed-month review reads snapshot instead of current bank health, and works in dark mode", async ({ page }) => {
  await seedSyntheticBrowser(page, { closedPrior: true });
  await page.locator('nav [data-tab="budget"]').click();
  await page.locator("#period-select").selectOption("2026-09");
  await page.locator('.mr-budget-entry [data-action="monthly-review"]').click();
  await expect(page.locator("#monthly-review")).toContainText("Closed month");
  await expect(page.locator("#monthly-review")).toContainText("NT$900");
  await expect(page.locator("#monthly-review")).toContainText("Current bank checks are not applied retroactively");
  await expect(page.locator("#monthly-review .mr-bank-row")).toHaveCount(0);
  await page.locator('[data-action="close-modal"]').click();
  await page.locator('[data-action="settings"]').first().click();
  await page.locator('[role="dialog"] [data-action="set-theme"][data-theme="dark"]').click();
  await page.locator('[role="dialog"] [data-action="close-modal"]').first().click();
  await page.locator('.mr-budget-entry [data-action="monthly-review"]').click();
  await expect(page.locator("#monthly-review")).toBeVisible();
  const dimensions = await page.evaluate(() => {
    const review = document.querySelector(".monthly-review").getBoundingClientRect();
    return { right: review.right, viewport: document.documentElement.clientWidth };
  });
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport + 1);
  await page.locator('[data-action="close-modal"]').click();
  await page.locator('[data-action="privacy-toggle"]').click();
  await page.locator('.mr-budget-entry [data-action="monthly-review"]').click();
  await expect(page.locator("#monthly-review")).toContainText("••••");
  await expect(page.locator("#monthly-review")).not.toContainText("NT$900");
});

test("Spending Drivers identifies food overspend, actual category movers and exact-month Activity drill-down without writes", async ({ page }) => {
  await seedSyntheticBrowser(page, { closedPrior: true, trip: testTrip(), expenses: [trainExpense()] });
  await page.evaluate(async () => {
    const db = await import("/js/db.js");
    const p = await db.getOne("periods", "2026-10");
    await db.put("periods", { ...p, planSnapshot: {
      ...p.planSnapshot, salary: 85000, immediateWealth: 14000,
      lines: [
        { id: "rent", name: "Rent", ruleType: "fixed", budgetAmount: 23000 },
        { id: "food", name: "Food", ruleType: "cap", budgetAmount: 8500 },
        { id: "electricity-reserve", name: "Electricity Reserve", ruleType: "sinking_contribution", budgetAmount: 5000 },
      ],
    }});
    const previous = await db.getOne("monthlyCloses", "2026-09");
    await db.put("monthlyCloses", { ...previous, categoryActuals: { food: 900 } });
    await db.put("expenses", {
      id: "oct-food-driver", categoryId: "food", amount: 11000,
      budgetPeriodId: "2026-10", accountId: "ctbc", date: "2026-10-19",
      description: "Synthetic Food driver",
    });
    await db.put("expenses", {
      id: "oct-rent-driver", categoryId: "rent", amount: 23000,
      budgetPeriodId: "2026-10", accountId: "ctbc", date: "2026-10-18",
      description: "Synthetic Rent driver",
    });
    await db.put("expenses", {
      id: "sept-food-driver", categoryId: "food", amount: 900,
      budgetPeriodId: "2026-09", accountId: "ctbc", date: "2026-09-18",
      description: "Earlier recorded food",
    });
  });
  await page.reload();
  const before = await page.evaluate(async () => (await import("/js/db.js")).exportData());
  await page.locator('[data-action="monthly-review"]').first().click();
  const review = page.locator("#monthly-review");
  await expect(review.locator("#mr-spending-drivers")).toBeVisible();
  await expect(review.locator('.mr-driver-row[data-driver-category="food"]')).toContainText("Food");
  await expect(review.locator('.mr-driver-row[data-driver-category="food"]')).toContainText("NT$11,000");
  await expect(review.locator('.mr-driver-row[data-driver-category="food"]')).toContainText("Over plan by NT$2,500");
  await expect(review.locator('.mr-driver-row[data-driver-category="food"]')).toContainText("Up NT$10,100");
  await expect(review.locator('.mr-driver-row[data-driver-category="rent"]')).toContainText("NT$23,000");
  await expect(review.locator('.mr-driver-row[data-driver-category="rent"]')).toContainText("Within plan");
  await expect(review.locator(".mr-driver-alert")).toContainText("1 category is above");
  // Business Trip reimbursement expense is not part of personal spending.
  await expect(review.locator(".mr-metrics")).toContainText("NT$34,000");
  await expect(review.locator(".mr-metrics")).not.toContainText("NT$3,500");

  await review.locator('.mr-driver-row[data-driver-category="food"] [data-action="review-driver"]').click();
  await expect(page.locator(".topbar h1")).toHaveText("Activity");
  await expect(page.locator("#mr-activity-filter")).toContainText("Food expenses");
  await expect(page.locator("#mr-activity-filter")).toContainText("October 2026");
  await expect(page.locator(".activity-list .tx")).toHaveCount(1);
  await expect(page.locator(".activity-list")).toContainText("Synthetic Food driver");
  await expect(page.locator(".activity-list")).not.toContainText("Synthetic Rent driver");
  await expect(page.locator(".activity-list")).not.toContainText("Earlier recorded food");
  await page.locator('[data-action="clear-review-driver"]').click();
  await expect(page.locator("#mr-activity-filter")).toHaveCount(0);
  await expect(page.locator(".activity-list").filter({ hasText: "Synthetic Rent driver" })).toHaveCount(1);
  const after = await page.evaluate(async () => (await import("/js/db.js")).exportData());
  expect(after.data).toEqual(before.data);
});

test("Historical category detail gaps are disclosed, and drivers stay legible and private in dark mode", async ({ page }) => {
  await seedSyntheticBrowser(page, { closedPrior: true });
  await page.locator('[data-action="monthly-review"]').first().click();
  await expect(page.locator("#mr-spending-drivers")).toContainText("does not have a complete category breakdown");
  await expect(page.locator("#mr-spending-drivers .mr-movers")).toHaveCount(0);
  await page.locator('[data-action="close-modal"]').click();
  await page.locator('[data-action="settings"]').first().click();
  await page.locator('[role="dialog"] [data-action="set-theme"][data-theme="dark"]').click();
  await page.locator('[role="dialog"] [data-action="close-modal"]').first().click();
  await page.locator('[data-action="monthly-review"]').first().click();
  await expect(page.locator("#mr-spending-drivers")).toBeVisible();
  const width = await page.evaluate(() => {
    const modal = document.querySelector("#mr-spending-drivers").getBoundingClientRect();
    return { edge: modal.right, screen: document.documentElement.clientWidth };
  });
  expect(width.edge).toBeLessThanOrEqual(width.screen + 1);
  await page.locator('[data-action="close-modal"]').click();
  await page.locator('[data-action="privacy-toggle"]').click();
  await page.locator('[data-action="monthly-review"]').first().click();
  await expect(page.locator("#monthly-review")).toContainText("••••");
  await expect(page.locator("#mr-spending-drivers")).not.toContainText("NT$23,000");
});

test("Home quick insights ranks flexible categories and opens focused Spending Drivers without any writes", async ({ page }) => {
  await seedSyntheticBrowser(page, { closedPrior:true, trip:testTrip(), expenses:[trainExpense()] });
  await page.evaluate(async () => {
    const db=await import("/js/db.js");
    const p=await db.getOne("periods","2026-10");
    await db.put("periods",{...p,planSnapshot:{
      ...p.planSnapshot,salary:80000,immediateWealth:15000,
      lines:[
        {id:"rent",name:"Rent",ruleType:"fixed",budgetAmount:23000},
        {id:"food",name:"Food",ruleType:"cap",budgetAmount:8500},
        {id:"transport",name:"Transport",ruleType:"cap",budgetAmount:3000},
      ],
    }});
    for(const item of [
      {id:"quick-rent",categoryId:"rent",amount:23000,date:"2026-10-17"},
      {id:"quick-food",categoryId:"food",amount:11000,date:"2026-10-18"},
      {id:"quick-transport",categoryId:"transport",amount:2400,date:"2026-10-19"},
    ]) await db.put("expenses",{
      ...item,budgetPeriodId:"2026-10",accountId:"ctbc",
      description:"Synthetic "+item.categoryId,
    });
  });
  await page.reload();
  const preview=page.locator("#home-spending-insights");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("data-insights-period","2026-10");
  await expect(preview).toContainText("Spending drivers");
  await expect(preview).toContainText("Food");
  await expect(preview).toContainText("NT$11,000");
  await expect(preview).toContainText("Transport");
  await expect(preview).toContainText("NT$2,400");
  await expect(preview).not.toContainText("NT$23,000");
  await expect(preview).toContainText("1 flexible category is above");
  const before=await page.evaluate(async () => (await import("/js/db.js")).exportData());
  await preview.locator('[data-action="spending-drivers"]').click();
  const sheet=page.locator(".modal");
  await expect(page.locator("#monthly-review")).toBeVisible();
  await expect(page.locator("#monthly-review")).toHaveAttribute("data-review-period","2026-10");
  await expect(page.locator("#mr-spending-drivers")).toBeFocused();
  const position=await page.evaluate(() => {
    const modal=document.querySelector(".modal");
    const section=document.querySelector("#mr-spending-drivers");
    return {scroll:modal.scrollTop,top:section.getBoundingClientRect().top,
      sheetTop:modal.getBoundingClientRect().top,sheetBottom:modal.getBoundingClientRect().bottom};
  });
  expect(position.scroll).toBeGreaterThan(0);
  expect(position.top).toBeGreaterThanOrEqual(position.sheetTop-2);
  expect(position.top).toBeLessThan(position.sheetBottom);
  await expect(page.locator('#mr-spending-drivers .mr-driver-row[data-driver-category="food"]')).toContainText("Over plan by NT$2,500");
  await page.locator('[data-action="close-modal"]').click();
  const after=await page.evaluate(async () => (await import("/js/db.js")).exportData());
  expect(after.data).toEqual(before.data);
});

test("Budget shortcut preserves selected CLOSED funding month and jumps straight to Spending Drivers", async ({ page }) => {
  await seedSyntheticBrowser(page, {closedPrior:true});
  await page.locator('nav [data-tab="budget"]').click();
  await page.locator("#period-select").selectOption("2026-09");
  await expect(page.locator("#budget-review-shortcuts")).toBeVisible();
  await expect(page.locator("#budget-review-shortcuts")).toContainText("September 2026");
  await page.locator('#budget-review-shortcuts [data-action="spending-drivers"]').click();
  await expect(page.locator("#monthly-review")).toHaveAttribute("data-review-period","2026-09");
  await expect(page.locator("#monthly-review")).toContainText("Closed month");
  await expect(page.locator("#mr-spending-drivers")).toBeFocused();
  await expect(page.locator("#mr-spending-drivers")).toContainText("does not have a complete category breakdown");
  await page.locator('[data-action="close-modal"]').click();
  await expect(page.locator("#period-select")).toHaveValue("2026-09");
  await page.locator('#budget-review-shortcuts [data-action="monthly-review"]').click();
  await expect(page.locator("#monthly-review")).toHaveAttribute("data-review-period","2026-09");
  await expect(page.locator("#mr-spending-drivers")).not.toBeFocused();
});

test("Quick-insights empty state and dark/private iPhone layout keep shortcut usable", async ({ page }) => {
  await seedSyntheticBrowser(page);
  await expect(page.locator("#home-spending-insights")).toContainText("No flexible or unplanned personal category spending");
  await page.locator('[data-action="settings"]').first().click();
  await page.locator('[role="dialog"] [data-action="set-theme"][data-theme="dark"]').click();
  await page.locator('[role="dialog"] [data-action="close-modal"]').first().click();
  await page.locator('[data-action="privacy-toggle"]').click();
  await expect(page.locator("#home-spending-insights")).toBeVisible();
  const dimensions=await page.evaluate(()=>{
    const card=document.querySelector("#home-spending-insights").getBoundingClientRect();
    return {right:card.right,viewport:document.documentElement.clientWidth};
  });
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport+1);
  await page.locator('#home-spending-insights [data-action="spending-drivers"]').click();
  await expect(page.locator("#mr-spending-drivers")).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-theme","dark");
});
