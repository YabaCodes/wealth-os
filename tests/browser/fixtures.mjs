// Browser tests run ONLY against the localhost Playwright server.
// Every scenario uses a new, isolated browser context and a synthetic IndexedDB.
// Never load the public GitHub Pages app or any real financial backup.
export const TEST_MONTH = "2026-10";
export const PRIOR_MONTH = "2026-09";

export function syntheticPeriod(state = "funded") {
  return {
    id: TEST_MONTH,
    state,
    budgetRevision: 1,
    paydayRoutingSnapshot: { goalAllocs: [], createdAt: "2026-10-01T09:00:00Z" },
    planSnapshot: {
      salary: 0, tithe: 0, fixed: 0, caps: 0, sinking: 0, buffer: 0,
      assignedBeforeWealth: 0, immediateWealth: 0, lines: [],
    },
  };
}

export function testTrip() {
  return {
    id: "synthetic-trip", type: "business_trip", status: "active",
    title: "Synthetic Browser Test Trip", destination: "Test City",
    purpose: "Automated acceptance only", startDate: "2026-10-16",
    endDate: "2026-10-30", dailyAllowanceTwd: 3000,
    defaultCurrency: "EUR", mainPaymentMethod: "esun_card",
    reimbursementAccountId: "ctbc", fundingMode: "reimbursement",
    createdAt: "2026-10-12T09:00:00Z",
  };
}

export function trainExpense() {
  return {
    id: "train", projectId: "synthetic-trip",
    categoryId: "train_ticket", category: "Train Ticket", reimbursementType: "exact",
    recordType: "expense", originalAmount: 100, currency: "EUR",
    twdAmount: 3500, paymentMethod: "esun_card",
    date: "2026-10-17", description: "Synthetic rail fare",
  };
}

export function pendingDeposit() {
  return {
    id: "pending-hold", projectId: "synthetic-trip",
    categoryId: "car_rental", category: "Car Rental", reimbursementType: "exact",
    recordType: "refundable_deposit", depositStatus: "pending",
    originalAmount: 200, currency: "EUR", twdAmount: 7000,
    paymentMethod: "esun_card", date: "2026-10-17",
  };
}

export async function seedSyntheticBrowser(page, { period = syntheticPeriod(), trip = null, expenses = [],
  closedPrior = false, readyToClose = false } = {}) {
  await page.goto("/");
  await page.locator(".shell").waitFor();
  await page.evaluate(async ({ period, trip, expenses, closedPrior, readyToClose }) => {
    const db = await import("/js/db.js");
    const payload = await db.exportData();
    const data = payload.data;
    // Preserve genuine PUBLIC default accounts/categories; never import any user records.
    data.periods = [period];
    data.incomes = [];
    data.expenses = [];
    data.transfers = [];
    data.transferAllocations = [];
    data.adjustments = [];
    data.reconciliations = [];
    data.monthlyCloses = [];
    data.projects = trip ? [trip] : [];
    data.projectExpenses = expenses;
    data.projectSettlements = [];
    data.investmentSnapshots = [];
    if (closedPrior) {
      data.periods.push({
        id: "2026-09", state: "closed", closedAt: "2026-09-30T12:00:00Z",
        planSnapshot: structuredClone(period.planSnapshot),
      });
      data.monthlyCloses.push({
        id: "2026-09", budgetPeriodId: "2026-09", status: "closed",
        closedAt: "2026-09-30T12:00:00Z",
        expenses: 900, endingCoreWealth: 1000,
        endingAccountBalances: { ctbc: 5000, esun: 0, cash: 0, ibkrTwd: 0 },
        planSnapshot: structuredClone(period.planSnapshot),
      });
    }
    if (readyToClose) {
      data.goals = []; // Synthetic no-funding month with zero requirements.
      data.reconciliations.push({
        id: "ctbc-verified", accountId: "ctbc", date: "2026-10-18",
        actualBalance: 0, createdAt: "2026-10-18T10:00:00Z",
      });
      data.reconciliations.push({
        id: "esun-verified", accountId: "esun", date: "2026-10-18",
        actualBalance: 0, createdAt: "2026-10-18T10:00:00Z",
      });
    }
    await db.importData({ version: 1, exportedAt: "2026-10-18T12:00:00Z", data });
  }, { period, trip, expenses, closedPrior, readyToClose });
  await page.reload();
  await page.locator(".shell").waitFor();
}

export async function readBrowserStore(page, name) {
  return page.evaluate(async (store) => {
    const db = await import("/js/db.js");
    return db.getAll(store);
  }, name);
}
