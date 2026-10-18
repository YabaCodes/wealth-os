import {
  seedIfNeeded,
  getAll,
  getOne,
  put,
  bulkPut,
  remove,
  uid,
  exportData,
  importData,
  validateBackup,
  backupSummary,
  saveUndoSnapshot,
  getUndoSnapshot,
  clearUndoSnapshot,
  bucketBalances,
  accountBalances,
  wealthMetrics,
} from "./db.js";
import { INCOME_TYPES } from "./defaults.js";
import {
  money,
  pct,
  monthLabel,
  buildBudgetPlan,
  aggregateExpenses,
  budgetSummary,
  calculateSweep,
  allocateGoalSurplus,
  activeGoal,
  forecastMonthsToTarget,
  simulateWealthStrategy,
  simulateWealthStrategyWithGrowth,
} from "./calc.js";
import { askConfirm, notify, showError, toast, snapshotBars, animateBars, motionAllowed, watchKeyboard } from "./ui.js";
import {
  PROJECT_CATEGORIES,
  PROJECT_CURRENCIES,
  projectExpensesFor,
  projectKnownTwd as projectKnownTwdFromRows,
  projectMissingTwd as projectMissingTwdFromRows,
  projectPaymentTwd as projectPaymentTwdFromRows,
  projectOriginalTotals as projectOriginalTotalsFromRows,
  formatOriginal,
} from "./projects.js";
import {
  flexPace,
  isIrregularCap,
  capPace,
  monthPaceContext,
  spendingPaceFor as spendingPaceForRows,
} from "./pacing.js";
import {
  buildActivityRecords,
  filterActivityRecords,
  groupActivityByDay,
  dayHeading,
  isPurposeOnlyTransfer,
} from "./activity.js";
import {
  businessTripCategoryRules,
  parseCustomCategoryRules,
  projectBudgetSummary,
  projectCategoryBreakdown,
  mapLegacyBusinessExpense,
  unresolvedDeposits,
  allowanceDays,
  totalFlexibleAllowance,
  isRefundableDeposit,
  depositResolved,
  categoryRuleFor,
} from "./special-budgets.js";

const root = document.querySelector("#app");
let tab = "home";
let state = {};
let modal = null;
let selectedPeriodId = null;
let activityFilter = "all";
let activitySearch = "";
let modalDirty = false;
// Home week strip (v1.17): which week is shown and which day is picked. Not saved; resets with the month.
let homeWeekStart = null,
  homeDay = null;
let reachedGoals = null; // goals at target after the last load (null until the first load)
const APP_VERSION = "1.19.1";
const THEME_KEY = "wealthOSTheme";
// Theme: 'system' follows the phone's light/dark setting. A copy is kept in localStorage so
// index.html can apply it before the first paint (IndexedDB is too slow for that).
function resolvedTheme(pref) {
  return pref === "dark" ||
    (pref !== "light" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches)
    ? "dark"
    : "light";
}
function applyTheme(pref) {
  const t = resolvedTheme(pref || "system");
  document.documentElement.dataset.theme = t;
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute("content", t === "dark" ? "#0d1017" : "#111827");
  try {
    localStorage.setItem(THEME_KEY, pref || "system");
  } catch {}
}
if (window.matchMedia) {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if ((state.settings?.theme || "system") === "system") applyTheme("system");
  };
  mq.addEventListener ? mq.addEventListener("change", onChange) : mq.addListener?.(onChange);
}
const DATA_MODEL_VERSION = 190;

const today = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>'"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c],
  );
const privateValue = (value) => `<span class="privacy-sensitive">${value}</span>`;
const privateMoney = (value) => privateValue(money(value));
const nextMonthId = (dateStr) => {
  const d = new Date(`${dateStr}T12:00:00`);
  return `${d.getFullYear() + (d.getMonth() === 11 ? 1 : 0)}-${String(((d.getMonth() + 1) % 12) + 1).padStart(2, "0")}`;
};

async function migrateV131() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 131) return;

  const electricity = await getOne("buckets", "electricity");
  if (electricity) {
    await put("buckets", {
      ...electricity,
      accountId: "ctbc",
      countsTowardNetWorth: false,
      updatedAt: new Date().toISOString(),
    });
  }

  // v1.3 created combined planned payday transfers. They were only intentions and may
  // become stale when the user records one component separately. v1.3.1 derives payday
  // transfer requirements from the funding plan instead, so uncompleted system plans can
  // be safely removed while completed real transfers are preserved.
  const transfers = await getAll("transfers");
  const allocations = await getAll("transferAllocations");
  const stalePlans = transfers.filter(
    (t) => !t.deletedAt && t.status === "planned" && ["payday", "investment_contribution"].includes(t.transferType),
  );
  for (const t of stalePlans) {
    for (const a of allocations.filter((a) => a.transferId === t.id)) await remove("transferAllocations", a.id);
    await remove("transfers", t.id);
  }

  // Electricity remains physically in CTBC. Treat the monthly reserve as an internal
  // purpose allocation, not a CTBC → E.SUN bank transfer.
  const periods = await getAll("periods");
  const remainingTransfers = await getAll("transfers");
  const remainingAllocs = await getAll("transferAllocations");
  for (const period of periods.filter((p) => p.state !== "closed")) {
    const line = period.planSnapshot?.lines?.find(
      (x) => x.ruleType === "sinking_contribution" && x.bucketId === "electricity",
    );
    const target = Number(line?.budgetAmount || 0);
    if (target <= 0) continue;
    const completedIds = new Set(
      remainingTransfers
        .filter((t) => !t.deletedAt && t.status === "completed" && t.budgetPeriodId === period.id)
        .map((t) => t.id),
    );
    const already = remainingAllocs
      .filter((a) => completedIds.has(a.transferId) && a.bucketId === "electricity")
      .reduce((sum, a) => sum + Number(a.amount || 0), 0);
    const amount = Math.max(0, target - already);
    if (amount > 0.5) {
      const stamp = new Date().toISOString(),
        tid = uid("tr");
      await put("transfers", {
        id: tid,
        fromAccountId: "ctbc",
        toAccountId: "ctbc",
        amount,
        budgetPeriodId: period.id,
        status: "completed",
        plannedDate: period.fundedAt || today(),
        completedDate: period.fundedAt || today(),
        completedAt: stamp,
        transferType: "reserve_allocation",
        affectsPhysicalBalance: false,
        systemGenerated: true,
        createdAt: stamp,
        updatedAt: stamp,
      });
      await put("transferAllocations", {
        id: uid("ta"),
        transferId: tid,
        bucketId: "electricity",
        amount,
        goalId: null,
        label: "Electricity Reserve",
      });
    }
  }

  await put("settings", { ...settings, dataModelVersion: 131, updatedAt: new Date().toISOString() });
}

async function migrateV132() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 132) return;

  // Purpose allocations are bookkeeping only; they must never change a physical bank
  // balance. Mark every historical internal allocation explicitly so old records cannot
  // be interpreted as bank movements by future balance logic.
  const transfers = await getAll("transfers");
  for (const t of transfers) {
    const purposeOnly =
      t.fromAccountId === t.toAccountId || ["bucket_allocation", "reserve_allocation"].includes(t.transferType);
    if (purposeOnly && t.affectsPhysicalBalance !== false) {
      await put("transfers", {
        ...t,
        affectsPhysicalBalance: false,
        updatedAt: t.updatedAt || new Date().toISOString(),
      });
    }
  }

  // Repair the narrow duplicate-purpose-allocation case exposed during the Sep 30 live
  // migration: an already-assigned reconciliation difference could be assigned a second
  // time. Only remove a duplicate when (a) the virtual ledger is over the tracked bank
  // amount by the exact prior reconciliation difference and (b) two identical purpose
  // allocation records exist. This avoids guessing about legitimate distinct allocations.
  const recs = (await getAll("reconciliations"))
    .filter((r) => r.accountId === "esun" && !r.deletedAt)
    .sort((a, b) => `${a.date || ""}${a.createdAt || ""}`.localeCompare(`${b.date || ""}${b.createdAt || ""}`));
  const latestRec = recs.at(-1) || null;
  if (latestRec) {
    const baselineGap = Number(latestRec.actualBalance || 0) - Number(latestRec.expectedBalance || 0);
    if (baselineGap > 0.5) {
      const absNow = await accountBalances();
      const rawExpected = Number(absNow.esun || 0);
      const trackedBank = Number(latestRec.actualBalance || 0) + (rawExpected - Number(latestRec.expectedBalance || 0));
      const bb = await bucketBalances();
      const buckets = await getAll("buckets");
      const virtualTotal = buckets
        .filter((b) => b.accountId === "esun")
        .reduce((sum, b) => sum + Number(bb[b.id] || 0), 0);
      const over = virtualTotal - trackedBank;
      if (Math.abs(over - baselineGap) < 0.5) {
        const allTransfers = await getAll("transfers");
        const allAllocs = await getAll("transferAllocations");
        const candidates = allTransfers.filter(
          (t) =>
            !t.deletedAt &&
            t.status === "completed" &&
            t.transferType === "bucket_allocation" &&
            t.fromAccountId === "esun" &&
            t.toAccountId === "esun",
        );
        const signature = (t) =>
          allAllocs
            .filter((a) => a.transferId === t.id)
            .map((a) => `${a.bucketId}:${Number(a.amount || 0)}`)
            .sort()
            .join("|");
        const groups = new Map();
        for (const t of candidates) {
          if (Math.abs(Number(t.amount || 0) - baselineGap) >= 0.5) continue;
          const sig = signature(t);
          if (!sig) continue;
          if (!groups.has(sig)) groups.set(sig, []);
          groups.get(sig).push(t);
        }
        for (const group of groups.values()) {
          if (group.length < 2) continue;
          group.sort((a, b) =>
            String(a.createdAt || a.completedAt || a.completedDate || "").localeCompare(
              String(b.createdAt || b.completedAt || b.completedDate || ""),
            ),
          );
          const duplicate = group.at(-1);
          await put("transfers", {
            ...duplicate,
            deletedAt: new Date().toISOString(),
            repairNote: "v1.3.2 removed duplicate E.SUN purpose allocation",
            updatedAt: new Date().toISOString(),
          });
          break;
        }
      }
    }
  }

  await put("settings", { ...settings, dataModelVersion: 132, updatedAt: new Date().toISOString() });
}

async function migrateV133() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 133) return;

  // v1.3.2 still derived the post-reconciliation bank roll-forward from the entire
  // historical ledger. Older reconciliation adjustments could therefore be counted
  // again after the reconciliation had already established the true bank baseline.
  // Rebuild the E.SUN comparison from only physical activity that happened after the
  // latest exact bank check.
  const recs = (await getAll("reconciliations"))
    .filter((r) => r.accountId === "esun" && !r.deletedAt)
    .sort((a, b) => `${a.date || ""}${a.createdAt || ""}`.localeCompare(`${b.date || ""}${b.createdAt || ""}`));
  const rec = recs.at(-1) || null;
  if (rec) {
    const after = (effectiveDate, stamp) => {
      const rd = String(rec.date || "");
      const ed = String(effectiveDate || "");
      if (ed > rd) return true;
      if (ed < rd) return false;
      return String(stamp || "") > String(rec.createdAt || "");
    };
    const [incomes, expenses, transfers, adjustments, buckets, allocs] = await Promise.all([
      getAll("incomes"),
      getAll("expenses"),
      getAll("transfers"),
      getAll("adjustments"),
      getAll("buckets"),
      getAll("transferAllocations"),
    ]);
    let delta = 0;
    for (const x of incomes) {
      if (!x.deletedAt && x.accountId === "esun" && after(x.dateReceived || x.date, x.createdAt || x.updatedAt))
        delta += Number(x.amount || 0);
    }
    for (const x of expenses) {
      if (!x.deletedAt && x.accountId === "esun" && after(x.dateReceived || x.date, x.createdAt || x.updatedAt))
        delta -= Number(x.amount || 0);
    }
    for (const t of transfers) {
      if (t.deletedAt || t.status !== "completed") continue;
      const purposeOnly =
        t.affectsPhysicalBalance === false ||
        t.fromAccountId === t.toAccountId ||
        ["bucket_allocation", "reserve_allocation"].includes(t.transferType);
      if (purposeOnly || !after(t.completedDate || t.plannedDate, t.completedAt || t.updatedAt || t.createdAt))
        continue;
      if (t.toAccountId === "esun") delta += Number(t.amount || 0);
      if (t.fromAccountId === "esun") delta -= Number(t.amount || 0);
    }
    for (const a of adjustments) {
      if (!a.deletedAt && a.accountId === "esun" && after(a.date, a.createdAt || a.updatedAt))
        delta += Number(a.amount || 0);
    }
    const tracked = Number(rec.actualBalance || 0) + delta;

    // Remove the duplicate NT$4,500-style purpose allocation only when the current
    // virtual ledger is over the correctly rolled-forward bank balance by exactly the
    // original positive reconciliation gap, and duplicate matching internal allocations
    // actually exist. This is deliberately narrow so legitimate allocations are untouched.
    const baselineGap = Number(rec.actualBalance || 0) - Number(rec.expectedBalance || 0);
    const bb = await bucketBalances();
    const virtualTotal = buckets
      .filter((b) => b.accountId === "esun")
      .reduce((sum, b) => sum + Number(bb[b.id] || 0), 0);
    const over = virtualTotal - tracked;
    if (baselineGap > 0.5 && Math.abs(over - baselineGap) < 0.5) {
      const candidates = transfers.filter(
        (t) =>
          !t.deletedAt &&
          t.status === "completed" &&
          t.transferType === "bucket_allocation" &&
          t.fromAccountId === "esun" &&
          t.toAccountId === "esun" &&
          Math.abs(Number(t.amount || 0) - baselineGap) < 0.5,
      );
      const signature = (t) =>
        allocs
          .filter((a) => a.transferId === t.id)
          .map((a) => `${a.bucketId}:${Number(a.amount || 0)}`)
          .sort()
          .join("|");
      const groups = new Map();
      for (const t of candidates) {
        const sig = signature(t);
        if (!sig) continue;
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(t);
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        group.sort((a, b) =>
          String(a.createdAt || a.completedAt || a.completedDate || "").localeCompare(
            String(b.createdAt || b.completedAt || b.completedDate || ""),
          ),
        );
        const duplicate = group.at(-1);
        await put("transfers", {
          ...duplicate,
          deletedAt: new Date().toISOString(),
          repairNote: "v1.3.3 removed duplicate E.SUN purpose allocation after reconciliation-baseline repair",
          updatedAt: new Date().toISOString(),
        });
        break;
      }
    }
  }

  await put("settings", { ...settings, dataModelVersion: 133, updatedAt: new Date().toISOString() });
}

async function migrateV140() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 140) return;
  // Reliability release only: do not mutate balances, transactions, reconciliations,
  // allocations, goals, or funding months during this upgrade.
  await put("settings", { ...settings, dataModelVersion: 140, appVersion: "1.4", updatedAt: new Date().toISOString() });
}

async function migrateV150() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 150) return;
  const next = {
    ...settings,
    forecastInvestmentReturn: Number.isFinite(Number(settings?.forecastInvestmentReturn))
      ? Number(settings.forecastInvestmentReturn)
      : 7,
    forecastSalaryGrowth: Number.isFinite(Number(settings?.forecastSalaryGrowth))
      ? Number(settings.forecastSalaryGrowth)
      : 3,
    conservativeInvestmentReturn: Number.isFinite(Number(settings?.conservativeInvestmentReturn))
      ? Number(settings.conservativeInvestmentReturn)
      : 4,
    conservativeSalaryGrowth: Number.isFinite(Number(settings?.conservativeSalaryGrowth))
      ? Number(settings.conservativeSalaryGrowth)
      : 1,
    aggressiveInvestmentReturn: Number.isFinite(Number(settings?.aggressiveInvestmentReturn))
      ? Number(settings.aggressiveInvestmentReturn)
      : 9,
    aggressiveSalaryGrowth: Number.isFinite(Number(settings?.aggressiveSalaryGrowth))
      ? Number(settings.aggressiveSalaryGrowth)
      : 5,
    dataModelVersion: 150,
    appVersion: "1.5",
    updatedAt: new Date().toISOString(),
  };
  await put("settings", next);
}

async function migrateV160() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 160) return;
  // v1.6 is a quality-of-life release. It adds no new financial ledger records and
  // deliberately does not rewrite balances, reconciliations, allocations or history.
  await put("settings", { ...settings, dataModelVersion: 160, appVersion: "1.6", updatedAt: new Date().toISOString() });
}

async function migrateV161() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 161) return;
  // v1.6.1 fixes annual Tithe reporting only. It does not create, delete, reclassify,
  // or rewrite any financial ledger records. Historical purpose corrections and
  // reallocations remain in the audit trail; annual Tithe reporting nets corrections and excludes pure purpose moves.
  await put("settings", {
    ...settings,
    dataModelVersion: 161,
    appVersion: "1.6.1",
    updatedAt: new Date().toISOString(),
  });
}

async function migrateV170() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 170) return;
  // v1.7 adds month-operation, data-health and snapshot metadata only. It deliberately
  // does not rewrite financial balances, transactions, allocations, reconciliations or goals.
  // Existing fixed categories already generate expected monthly obligations; mark them
  // explicitly so future releases can distinguish expectations from real expenses.
  const categories = await getAll("categories");
  for (const c of categories) {
    if (c.ruleType === "fixed" && c.expectedEachMonth !== true) {
      await put("categories", { ...c, expectedEachMonth: true, updatedAt: c.updatedAt || new Date().toISOString() });
    }
  }
  await put("settings", { ...settings, dataModelVersion: 170, appVersion: "1.7", updatedAt: new Date().toISOString() });
}

async function migrateV171() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 171) return;
  // v1.7.1 is a branding/PWA-icon update only. No financial records are modified.
  await put("settings", {
    ...settings,
    dataModelVersion: 171,
    appVersion: "1.7.1",
    updatedAt: new Date().toISOString(),
  });
}

async function migrateV172() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 172) return;
  // v1.7.2 changes only PWA icon metadata/cache-busting URLs. No financial records are modified.
  await put("settings", {
    ...settings,
    dataModelVersion: 172,
    appVersion: "1.7.2",
    updatedAt: new Date().toISOString(),
  });
}

async function migrateV173() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 173) return;
  // v1.7.3 adds a zero-balance Cash Wallet and a local privacy preference only.
  // No existing balances, transactions, allocations, reconciliations, goals or months are rewritten.
  const cash = await getOne("accounts", "cash");
  if (!cash) {
    await put("accounts", {
      id: "cash",
      name: "Cash Wallet",
      type: "cash",
      role: "cash",
      currency: "TWD",
      openingBalance: 0,
      active: true,
      createdAt: new Date().toISOString(),
    });
  }
  await put("settings", {
    ...settings,
    privacyMode: settings?.privacyMode === true,
    dataModelVersion: 173,
    appVersion: "1.7.3",
    updatedAt: new Date().toISOString(),
  });
}

async function migrateV174() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 174) return;
  // v1.7.4 adds current-month budget syncing and spending-pace insights.
  // No expenses, transfers, reconciliations, allocations or closed-month plans are rewritten.
  await put("settings", {
    ...settings,
    applyBudgetChangesToCurrentMonth: settings?.applyBudgetChangesToCurrentMonth !== false,
    dataModelVersion: 174,
    appVersion: "1.7.4",
    updatedAt: new Date().toISOString(),
  });
}

async function migrateV180() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 180) return;
  // v1.8 adds isolated reimbursable-project ledgers. Project expenses do not touch
  // monthly budgets or physical account balances. Only the final settlement surplus
  // or shortfall is posted to the personal ledger.
  const shortfall = await getOne("categories", "project-shortfall");
  if (!shortfall)
    await put("categories", {
      id: "project-shortfall",
      name: "Project Shortfall",
      group: "Special Project",
      ruleType: "expense_only",
      defaultAmount: 0,
      active: true,
      hiddenFromManualEntry: true,
      sort: 36,
      createdAt: new Date().toISOString(),
    });
  await put("settings", { ...settings, dataModelVersion: 180, appVersion: "1.8", updatedAt: new Date().toISOString() });
}

async function migrateV181() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 181) return;
  // v1.8.1 narrows Privacy Mode to sensitive balances and wealth totals.
  // Budgets, spending/activity amounts and special-project expenses remain visible.
  // No financial records are modified.
  await put("settings", {
    ...settings,
    dataModelVersion: 181,
    appVersion: "1.8.1",
    updatedAt: new Date().toISOString(),
  });
}

async function migrateV182() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 182) return;
  // v1.12 adds a Household flexible cap (laundry, toiletries, cleaning) with no amount: set it in
  // Settings → Budget rules. Skipped if a category with that name already exists. It is also added,
  // at zero, to any open month's plan so Household expenses count there; zero changes no totals.
  const categories = await getAll("categories");
  const stamp = new Date().toISOString();
  if (!categories.some((c) => c.id === "household" || String(c.name || "").trim().toLowerCase() === "household")) {
    const water = categories.find((c) => c.id === "water"),
      misc = categories.find((c) => c.id === "misc");
    const sort = water && misc ? (Number(water.sort) + Number(misc.sort)) / 2 : Number(water?.sort ?? 34) + 0.5;
    const household = {
      id: "household",
      name: "Household",
      group: "Flexible",
      ruleType: "cap",
      defaultAmount: 0,
      active: true,
      sort,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await put("categories", household);
    for (const period of await getAll("periods")) {
      const snap = period.planSnapshot;
      if (period.state === "closed" || !snap || !Array.isArray(snap.lines)) continue;
      if (snap.lines.some((l) => l.id === "household")) continue;
      await put("periods", { ...period, planSnapshot: { ...snap, lines: [...snap.lines, { ...household, budgetAmount: 0 }] } });
    }
  }
  await put("settings", { ...settings, dataModelVersion: 182, appVersion: "1.12.0", updatedAt: stamp });
}

async function migrateV190() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 190) return;
  // v1.19 extends the existing Special Project records in-place with optional Special Budget fields.
  // No historical project or expense record is rewritten automatically; legacy projects remain readable
  // and can be deliberately converted from their own detail screen.
  await put("settings", {
    ...settings,
    dataModelVersion: 190,
    appVersion: "1.19.0",
    updatedAt: new Date().toISOString(),
  });
}

async function syncReleaseMetadata() {
  const settings = await getOne("settings", "app");
  if (!settings) return;
  const storedModel = Number(settings.dataModelVersion || 0);
  if (settings.appVersion === APP_VERSION && storedModel === DATA_MODEL_VERSION) return;
  await put("settings", {
    ...settings,
    appVersion: APP_VERSION,
    dataModelVersion: Math.max(storedModel, DATA_MODEL_VERSION),
    updatedAt: new Date().toISOString(),
  });
}

async function load() {
  await seedIfNeeded();
  await migrateV131();
  await migrateV132();
  await migrateV133();
  await migrateV140();
  await migrateV150();
  await migrateV160();
  await migrateV161();
  await migrateV170();
  await migrateV171();
  await migrateV172();
  await migrateV173();
  await migrateV174();
  await migrateV180();
  await migrateV181();
  await migrateV182();
  await migrateV190();
  await syncReleaseMetadata();
  const keys = [
    "accounts",
    "buckets",
    "categories",
    "goals",
    "periods",
    "incomes",
    "expenses",
    "transfers",
    "transferAllocations",
    "investmentSnapshots",
    "reconciliations",
    "adjustments",
    "monthlyCloses",
    "projects",
    "projectExpenses",
    "projectSettlements",
  ];
  const vals = await Promise.all(keys.map(getAll));
  keys.forEach((k, i) => (state[k] = vals[i]));
  state.settings = await getOne("settings", "app");
  state.hasUndo = !!(await getUndoSnapshot().catch(() => null));
  applyTheme(state.settings?.theme || "system");
  state.bucketBalances = await bucketBalances();
  state.accountBalances = await accountBalances();
  state.wealth = await wealthMetrics();
  const open = state.periods.filter((p) => p.state !== "closed").sort((a, b) => b.id.localeCompare(a.id));
  const any = [...state.periods].sort((a, b) => b.id.localeCompare(a.id));
  if (!selectedPeriodId) selectedPeriodId = (open[0] || any[0])?.id || null;
  // v1.17: a goal that reaches its target gets a short note after the save message.
  const reached = new Set(
    state.goals.filter((g) => Number(g.targetAmount || 0) > 0 && goalBal(g) + 0.5 >= Number(g.targetAmount)).map((g) => g.id),
  );
  const newly = reachedGoals ? [...reached].filter((id) => !reachedGoals.has(id)) : [];
  reachedGoals = reached;
  render();
  if (newly.length) {
    const g = goal(newly[0]);
    setTimeout(() => toast(`${g?.name || "Goal"} reached its target · ${money(g?.targetAmount || 0)}`, "good"), 2700);
  }
}

function currentPeriod() {
  return state.periods.find((p) => p.id === selectedPeriodId) || null;
}
function isClosedPeriod(periodId) {
  return state.periods.find((p) => p.id === periodId)?.state === "closed";
}
function assertPeriodEditable(periodId) {
  if (periodId && isClosedPeriod(periodId))
    throw new Error(`${monthLabel(periodId)} is closed. Reopen the month before changing period-linked records.`);
}
function formatMonths(m) {
  if (m === null || m === undefined || !isFinite(m)) return "—";
  if (m === 0) return "Now";
  return `${Math.floor(m / 12)}y ${m % 12}m`;
}
function periodRegularIncome(periodId) {
  return state.incomes
    .filter((i) => i.budgetPeriodId === periodId && !i.deletedAt && i.incomeType === "regular_income")
    .reduce((a, b) => a + Number(b.amount), 0);
}
function periodEligibleIncome(periodId) {
  return state.incomes
    .filter((i) => i.budgetPeriodId === periodId && !i.deletedAt && i.titheEligible)
    .reduce((a, b) => a + Number(b.amount), 0);
}
function planFor(periodId) {
  const p = state.periods.find((x) => x.id === periodId);
  if (p?.planSnapshot) return p.planSnapshot;
  const closedSnapshot = state.monthlyCloses.find(
    (x) => (x.budgetPeriodId === periodId || x.id === periodId) && x.planSnapshot,
  );
  if (closedSnapshot?.planSnapshot) return closedSnapshot.planSnapshot;
  const salary = periodRegularIncome(periodId);
  return buildBudgetPlan({ income: salary, categories: state.categories, settings: state.settings });
}
function expenseTotals(periodId) {
  return aggregateExpenses(state.expenses, periodId);
}
function completedCoreWealth(periodId) {
  const completed = state.transfers.filter(
    (t) => t.status === "completed" && !t.deletedAt && t.budgetPeriodId === periodId,
  );
  const complete = new Set(completed.map((t) => t.id));
  const coreBucketIds = new Set(state.buckets.filter((b) => b.countsTowardCoreWealth).map((b) => b.id));
  const bucketCore = state.transferAllocations
    .filter((a) => complete.has(a.transferId) && coreBucketIds.has(a.bucketId))
    .reduce((s, a) => s + Number(a.amount), 0);
  const investmentIds = new Set(state.accounts.filter((a) => a.role === "investment").map((a) => a.id));
  const invested = completed
    .filter((t) => investmentIds.has(t.toAccountId) && !investmentIds.has(t.fromAccountId))
    .reduce((s, t) => s + Number(t.amount || 0), 0);
  return bucketCore + invested;
}
function completedGoalFunding(periodId) {
  const complete = new Set(
    state.transfers
      .filter((t) => t.status === "completed" && !t.deletedAt && t.budgetPeriodId === periodId)
      .map((t) => t.id),
  );
  const sinkIds = new Set(
    state.buckets.filter((b) => ["sinking_fund", "operating_reserve"].includes(b.bucketType)).map((b) => b.id),
  );
  return state.transferAllocations
    .filter((a) => complete.has(a.transferId) && sinkIds.has(a.bucketId))
    .reduce((s, a) => s + Number(a.amount), 0);
}
function physicalAccount(id) {
  return state.accounts.find((a) => a.id === id);
}
function bucket(id) {
  return state.buckets.find((b) => b.id === id);
}
function category(id) {
  return state.categories.find((c) => c.id === id);
}
function goal(id) {
  return state.goals.find((g) => g.id === id);
}
function project(id) {
  return state.projects.find((x) => x.id === id && !x.deletedAt) || null;
}
function projectExpenses(projectId) {
  return projectExpensesFor(state.projectExpenses, projectId);
}
function projectSettlement(projectId) {
  return state.projectSettlements.find((x) => x.projectId === projectId && !x.deletedAt) || null;
}
function projectKnownTwd(projectId) {
  return projectKnownTwdFromRows(state.projectExpenses, projectId);
}
function projectMissingTwd(projectId) {
  return projectMissingTwdFromRows(state.projectExpenses, projectId);
}
function projectPaymentTwd(projectId, method) {
  return projectPaymentTwdFromRows(state.projectExpenses, projectId, method);
}
function projectOriginalTotals(projectId) {
  return projectOriginalTotalsFromRows(state.projectExpenses, projectId);
}
function activeSpecialBudgetReserve() {
  return state.projects
    .filter((p) => !p.deletedAt && p.fundingMode === "trip_wallet" && !projectSettlement(p.id))
    .reduce((sum, p) => sum + Math.max(0, Number(p.tripWalletAllocatedTwd || 0)), 0);
}
function projectStatusTag(p) {
  const settled = projectSettlement(p.id);
  if (settled) return '<span class="tag good-tag">Settled</span>';
  return '<span class="tag">Active</span>';
}
function totalExpenses(periodId) {
  return state.expenses
    .filter((e) => e.budgetPeriodId === periodId && !e.deletedAt)
    .reduce((s, e) => s + Number(e.amount), 0);
}
function entryPeriodId() {
  const selected = currentPeriod();
  if (selected && selected.state !== "closed") return selected.id;
  return [...state.periods].filter((p) => p.state !== "closed").sort((a, b) => b.id.localeCompare(a.id))[0]?.id || null;
}
function activityRecords() {
  return buildActivityRecords({
    expenses: state.expenses,
    incomes: state.incomes,
    transfers: state.transfers,
    categories: state.categories,
    accounts: state.accounts,
    incomeTypes: INCOME_TYPES,
  });
}
// v1.12 sweep rules: recorded fixed bills count their difference from the budget, and payday money already
// sent beyond the current plan is taken off the sweep. Open months use them; months closed before v1.12
// keep exactly the numbers they were closed with.
function sweepRulesFor(p) {
  return !p || p.state !== "closed" || Number(p.sweepRules || 0) >= 2 ? 2 : 1;
}
// Money payday actually moved to wealth (goals and investments) for this funding month; Tithe excluded.
function completedPaydayWealth(periodId) {
  const ids = new Set();
  let total = 0;
  for (const t of state.transfers) {
    if (t.deletedAt || t.budgetPeriodId !== periodId || t.status !== "completed") continue;
    if (!["payday", "investment_contribution"].includes(t.transferType)) continue;
    ids.add(t.id);
    total += Number(t.amount || 0);
  }
  const tithe = state.transferAllocations
    .filter((a) => ids.has(a.transferId) && a.bucketId === "tithe")
    .reduce((sum, a) => sum + Number(a.amount || 0), 0);
  return Math.max(0, total - tithe);
}
function sweepInfo(periodId) {
  const p = state.periods.find((x) => x.id === periodId),
    rules = sweepRulesFor(p);
  const plan = planFor(periodId),
    base = calculateSweep({
      budgetLines: plan.lines,
      expenseTotals: expenseTotals(periodId),
      includeFixedBills: rules >= 2,
    });
  // A budget change after payday (say a new Household cap) lowers this month's wealth plan, but payday already
  // sent the old, higher amount. That money has left the operating account, so the sweep is smaller by as much.
  const overSent =
    rules >= 2 ? completedPaydayWealth(periodId) - Math.max(0, Math.round(Number(plan.immediateWealth || 0))) : 0;
  const paydayOverSent = overSent > 0.5 ? overSent : 0,
    supported = Math.max(0, base.available - paydayOverSent);
  const reserved = state.transfers
    .filter(
      (t) =>
        !t.deletedAt &&
        t.budgetPeriodId === periodId &&
        t.transferType === "month_end_sweep" &&
        ["planned", "completed"].includes(t.status),
    )
    .reduce((s, t) => s + Number(t.amount || 0), 0);
  return {
    ...base,
    rules,
    paydayOverSent,
    supported,
    alreadySwept: reserved,
    available: Math.max(0, supported - reserved),
    overSwept: Math.max(0, reserved - supported),
    netAfterSweep: base.net - paydayOverSent - reserved,
  };
}
function monthCloseStatus(periodId) {
  const p = state.periods.find((x) => x.id === periodId);
  const plan = planFor(periodId),
    totals = expenseTotals(periodId),
    sweep = sweepInfo(periodId);
  const pending = state.transfers.filter(
    (t) => !t.deletedAt && t.budgetPeriodId === periodId && t.status === "planned",
  );
  const fixedLines = plan.lines.filter((x) => x.ruleType === "fixed");
  const missingFixed = fixedLines.filter((x) => !fixedPaid(totals[x.id]));
  const ct = accountSnapshot("ctbc"),
    es = esunSnapshot();
  const reserveFunded = plan.lines
    .filter((x) => x.ruleType === "sinking_contribution")
    .reduce((sum, x) => sum + completedAllocationToBucket(periodId, x.bucketId), 0);
  const titheAllocated = completedTithe(periodId),
    titheExpected = expectedTithe(periodId);
  const payday = paydayRequirements(periodId);
  const fundingOk = reserveFunded + 0.5 >= plan.sinking && payday.totalOutstanding <= 0.5;
  const bankOk = ct.verified && Math.abs(ct.difference) < 0.5 && es.verified && es.bankOk && es.allocationOk;
  const hardBlockers = [];
  if (pending.length)
    hardBlockers.push(`${pending.length} planned transfer${pending.length === 1 ? "" : "s"} still pending`);
  if (sweep.available > 0.5) hardBlockers.push(`${money(sweep.available)} still available to sweep`);
  if (sweep.overSwept > 0.5)
    hardBlockers.push(`${money(sweep.overSwept)} was swept beyond the current available amount`);
  if (!fundingOk) hardBlockers.push("payday allocations are incomplete");
  if (titheAllocated + 0.5 < titheExpected)
    hardBlockers.push(`${money(titheExpected - titheAllocated)} of tithe is not yet allocated`);
  if (!bankOk) hardBlockers.push("bank reconciliation or E.SUN purpose allocation is incomplete");
  return {
    p,
    plan,
    totals,
    sweep,
    pending,
    missingFixed,
    ct,
    es,
    reserveFunded,
    titheAllocated,
    titheExpected,
    payday,
    fundingOk,
    bankOk,
    hardBlockers,
    ready: hardBlockers.length === 0,
  };
}
function latestInvestmentTwd() {
  const usd = Number(state.accountBalances?.ibkr || 0);
  return usd * Number(state.settings.usdTwdRate || 1);
}
function goalBal(g) {
  return Number(state.bucketBalances[g.bucketId] || 0);
}
function goalStatus(g) {
  const bal = goalBal(g),
    target = Number(g.targetAmount || 0);
  if (target > 0 && bal >= target) return { key: "complete", label: "Complete", className: "good-tag" };
  if (g.status === "paused") return { key: "paused", label: "Paused", className: "" };
  if (g.prerequisiteGoalId) {
    const pg = goal(g.prerequisiteGoalId);
    if (pg && goalBal(pg) < Number(g.prerequisiteAmount || 0))
      return { key: "waiting", label: "Waiting", className: "warn-tag" };
  }
  return { key: "active", label: "Active", className: "good-tag" };
}
function periodAllIncome(periodId) {
  return state.incomes
    .filter((i) => i.budgetPeriodId === periodId && !i.deletedAt)
    .reduce((a, b) => a + Number(b.amount || 0), 0);
}
function periodRecord(periodId) {
  const p = state.periods.find((x) => x.id === periodId);
  if (!p) return null;
  const close = state.monthlyCloses.find(
    (x) => (x.budgetPeriodId === periodId || x.id === periodId) && x.status === "closed",
  );
  const regularIncome = close ? Number(close.income || 0) : periodRegularIncome(periodId);
  const totalIncome = close ? Number(close.totalIncome ?? close.income ?? 0) : periodAllIncome(periodId);
  const expenses = close ? Number(close.expenses || 0) : totalExpenses(periodId);
  const wealthContribution = close ? Number(close.wealthContribution || 0) : completedCoreWealth(periodId);
  const actuals = close?.categoryActuals || expenseTotals(periodId);
  const contributionRate = regularIncome > 0 ? wealthContribution / regularIncome : 0;
  const latestId = [...state.periods].sort((a, b) => a.id.localeCompare(b.id)).at(-1)?.id || null;
  const coreWealth = close
    ? Number(close.endingCoreWealth || 0)
    : periodId === latestId
      ? Number(state.wealth.coreWealth || 0)
      : null;
  const financialNetWorth = close
    ? Number(close.endingFinancialNetWorth || 0)
    : periodId === latestId
      ? Number(state.wealth.financialNetWorth || 0)
      : null;
  return {
    id: periodId,
    state: p.state,
    closed: !!close,
    regularIncome,
    totalIncome,
    expenses,
    wealthContribution,
    contributionRate,
    actuals,
    coreWealth,
    financialNetWorth,
  };
}
function historyRecords() {
  return [...state.periods]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => periodRecord(p.id))
    .filter(Boolean);
}
function recentHistory(n = 3) {
  return historyRecords().slice(-n);
}
function averageCoreContribution(n = 3) {
  const xs = recentHistory(n).filter((x) => x.regularIncome > 0);
  return xs.length ? xs.reduce((s, x) => s + x.wealthContribution, 0) / xs.length : 0;
}
function averageGoalContribution(bucketId, n = 3) {
  const xs = recentHistory(n);
  if (!xs.length) return 0;
  return xs.reduce((sum, x) => sum + completedAllocationToBucket(x.id, bucketId), 0) / xs.length;
}
function dateAfterMonths(months) {
  if (months === null || months === undefined || !isFinite(months)) return "—";
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + Math.max(0, Math.ceil(months)));
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(d);
}
function titheContributedInYear(year) {
  const completed = state.transfers.filter((t) => !t.deletedAt && t.status === "completed");
  const byId = new Map(completed.map((t) => [t.id, t]));
  return state.transferAllocations.reduce((sum, a) => {
    const t = byId.get(a.transferId);
    if (!t || a.bucketId !== "tithe") return sum;
    const d = String(t.completedDate || t.plannedDate || "");
    if (!d.startsWith(String(year))) return sum;
    // Purpose reallocations only rename existing E.SUN money and are not new Tithe.
    // Direct bucket allocations can represent newly recognized unassigned Tithe cash;
    // include both positive and negative amounts so later corrections net out cleanly.
    if (["purpose_reallocation", "reserve_allocation"].includes(t.transferType)) return sum;
    if (t.transferType === "allocation_reversal") {
      const original = byId.get(t.reversalOf) || state.transfers.find((x) => x.id === t.reversalOf);
      if (original && ["purpose_reallocation", "reserve_allocation"].includes(original.transferType)) return sum;
    }
    return sum + Number(a.amount || 0);
  }, 0);
}
function completedContributionToBucketInYear(bucketId, year) {
  const nonContributionTypes = new Set(["bucket_allocation", "purpose_reallocation", "allocation_reversal"]);
  const completed = new Map(
    state.transfers.filter((t) => !t.deletedAt && t.status === "completed").map((t) => [t.id, t]),
  );
  return state.transferAllocations.reduce((sum, a) => {
    const t = completed.get(a.transferId);
    if (!t || nonContributionTypes.has(t.transferType)) return sum;
    const d = String(t.completedDate || t.plannedDate || "");
    if (!d.startsWith(String(year)) || a.bucketId !== bucketId || Number(a.amount || 0) <= 0) return sum;
    return sum + Number(a.amount || 0);
  }, 0);
}
function yearSummary(year) {
  const prefix = String(year);
  const income = state.incomes
    .filter((x) => !x.deletedAt && String(x.dateReceived || "").startsWith(prefix))
    .reduce((s, x) => s + Number(x.amount || 0), 0);
  const regularIncome = state.incomes
    .filter((x) => !x.deletedAt && x.incomeType === "regular_income" && String(x.dateReceived || "").startsWith(prefix))
    .reduce((s, x) => s + Number(x.amount || 0), 0);
  const expenses = state.expenses
    .filter((x) => !x.deletedAt && String(x.date || "").startsWith(prefix))
    .reduce((s, x) => s + Number(x.amount || 0), 0);
  const tithe = titheContributedInYear(year);
  const emergency = completedContributionToBucketInYear("emergency", year);
  const investments = state.transfers
    .filter(
      (t) =>
        !t.deletedAt &&
        t.status === "completed" &&
        t.toAccountId === "ibkr" &&
        t.fromAccountId !== "ibkr" &&
        String(t.completedDate || t.plannedDate || "").startsWith(prefix),
    )
    .reduce((s, t) => s + Number(t.amount || 0), 0);
  const coreBucketIds = new Set(state.buckets.filter((b) => b.countsTowardCoreWealth).map((b) => b.id));
  const coreBuckets = [...coreBucketIds].reduce((sum, id) => sum + completedContributionToBucketInYear(id, year), 0);
  const wealth = coreBuckets + investments;
  const points = historyRecords()
    .filter((x) => x.id.startsWith(prefix) && x.financialNetWorth !== null)
    .map((x) => x.financialNetWorth);
  const netWorthChange = points.length >= 2 ? points.at(-1) - points[0] : null;
  return {
    income,
    regularIncome,
    expenses,
    tithe,
    emergency,
    investments,
    wealth,
    netWorthChange,
    months: historyRecords().filter((x) => x.id.startsWith(prefix)).length,
  };
}
function trendSvg(records, key, { percent = false } = {}) {
  const pts = records.filter((x) => Number.isFinite(Number(x[key])));
  if (pts.length < 2) return "";
  const vals = pts.map((x) => Number(x[key]));
  const min = Math.min(...vals),
    max = Math.max(...vals),
    span = Math.max(1, max - min);
  const coords = vals.map((v, i) => `${10 + (i / (vals.length - 1)) * 300},${90 - ((v - min) / span) * 72}`).join(" ");
  const dots = vals
    .map((v, i) => `<circle cx="${10 + (i / (vals.length - 1)) * 300}" cy="${90 - ((v - min) / span) * 72}" r="3"/>`)
    .join("");
  return `<div class="trend-wrap"><svg class="trend-svg" viewBox="0 0 320 100" preserveAspectRatio="none"><line x1="10" y1="90" x2="310" y2="90"/><polyline points="${coords}"/>${dots}</svg><div class="trend-labels">${pts.map((x) => `<span>${esc(monthLabel(x.id).split(" ")[0].slice(0, 3))}</span>`).join("")}</div></div>`;
}
function contributionBars(records) {
  if (!records.length) return "";
  const max = Math.max(0.01, ...records.map((x) => x.contributionRate));
  return `<div class="history-bars">${records.map((x) => `<div class="history-bar-item"><div class="history-bar-track"><span style="height:${Math.max(3, (x.contributionRate / max) * 100)}%"></span></div><strong>${pct(x.contributionRate)}</strong><small>${esc(monthLabel(x.id).split(" ")[0].slice(0, 3))}</small></div>`).join("")}</div>`;
}
function signedMoney(v) {
  const n = Number(v || 0);
  return `${n > 0 ? "+" : ""}${money(n)}`;
}
function deltaClass(v) {
  return Number(v) > 0 ? "good" : Number(v) < 0 ? "bad" : "";
}
function currentPaceMonthly() {
  const avg = averageCoreContribution(3);
  const p = currentPeriod();
  const planned = p ? Math.max(0, planFor(p.id).immediateWealth) : 0;
  return avg > 0 ? avg : planned;
}
function latestRegularTakeHome() {
  const xs = historyRecords().filter((x) => Number(x.regularIncome || 0) > 0);
  return Number(xs.at(-1)?.regularIncome || 0);
}
function forecastBaselineSalary() {
  return latestRegularTakeHome() || Number(state.settings.forecastSalary || 0);
}
function goalPaceText(g) {
  const bal = goalBal(g),
    remaining = Math.max(0, Number(g.targetAmount || 0) - bal);
  if (remaining <= 0) return "Complete";
  let pace = averageGoalContribution(g.bucketId, 3);
  if (g.id === "goal-emergency" && pace <= 0) pace = currentPaceMonthly();
  if (pace <= 0) return "Need contribution history";
  const months = Math.ceil(remaining / pace);
  return `At current pace: ${dateAfterMonths(months)} · ~${money(pace)}/mo`;
}
function scenarioFor(returnPct, growthPct, extra = 0, salaryOverride = null) {
  const salary = Number((salaryOverride ?? forecastBaselineSalary()) || 0);
  const plan = buildBudgetPlan({ income: salary, categories: state.categories, settings: state.settings });
  const monthly = Math.max(0, plan.immediateWealth + Number(extra || 0)),
    em = goal("goal-emergency"),
    trip = goal("goal-home-trip");
  const targets = [1000000, 3000000, 5000000, 10000000, 30000000];
  const sim = simulateWealthStrategyWithGrowth({
    emergencyStart: Number(state.bucketBalances.emergency || 0),
    travelStart: Number(state.bucketBalances["home-trip"] || 0),
    investmentStart: latestInvestmentTwd(),
    monthlyCapacity: monthly,
    startingSalary: salary,
    annualSalaryGrowth: Number(growthPct || 0) / 100,
    raiseCaptureRate: Number(state.settings.wealthRaisePercent || 75) / 100,
    annualReturn: Number(returnPct || 0) / 100,
    emergencyUnlock: Number(trip?.prerequisiteAmount || 200000),
    emergencyTarget: Number(em?.targetAmount || 300000),
    travelTarget: Number(trip?.targetAmount || 100000),
    travelMonthly: Number(trip?.monthlyTarget || 10000),
    months: 600,
    milestones: targets,
  });
  return { salary, monthly, targets, sim, returnPct: Number(returnPct || 0), growthPct: Number(growthPct || 0) };
}

function icon(name, extra = "") {
  const paths = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/>',
    budget:
      '<circle cx="5" cy="6" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="5" cy="18" r="1"/><path d="M9 6h11M9 12h11M9 18h11"/>',
    activity: '<path d="M8 4v16M8 4 4.5 7.5M8 4l3.5 3.5M16 20V4M16 20l-3.5-3.5M16 20l3.5-3.5"/>',
    goals: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    wealth:
      '<ellipse cx="9" cy="7" rx="5" ry="2.5"/><path d="M4 7v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V7M4 11v4c0 1.4 2.2 2.5 5 2.5 1.3 0 2.5-.25 3.4-.65"/><ellipse cx="16.5" cy="14.5" rx="3.5" ry="2"/><path d="M13 14.5v4c0 1.1 1.6 2 3.5 2s3.5-.9 3.5-2v-4"/>',
    forecast: '<path d="M3 18l6-6 4 4 7-9"/><path d="M16 7h4v4"/>',
    expense: '<path d="M12 4v13M7.5 12.5 12 17l4.5-4.5"/><path d="M5 20h14"/>',
    income: '<path d="M12 20V7M7.5 11.5 12 7l4.5 4.5"/><path d="M5 4h14"/>',
    transfer: '<path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4"/>',
    cash: '<path d="M5 8.5h14v9H5z"/><path d="M7.5 8.5V6.5h9v2M8 13h.01M16 13h.01"/><circle cx="12" cy="13" r="2"/>',
    project: '<path d="M4 7.5h16v11H4z"/><path d="M8 7.5V5.5h8v2M4 11h16M10 11v2h4v-2"/>',
    eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/>',
    eyeOff:
      '<path d="M3 3l18 18"/><path d="M10.6 6.2A8.8 8.8 0 0 1 12 6c6 0 9.5 6 9.5 6a15.8 15.8 0 0 1-3.1 3.8M6.1 6.1C3.8 7.7 2.5 12 2.5 12s3.5 6 9.5 6c1.5 0 2.9-.4 4.1-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.1.36.31.7.6 1 .3.29.66.5 1.1.6h.1v4h-.1c-.44.1-.8.31-1.1.6-.29.3-.5.64-.6 1z"/>',
    // v1.13: the bottom bar's "+" and category pictures
    plus: '<path d="M12 5v14M5 12h14"/>',
    pie: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5V12l6 6"/>',
    food: '<path d="M4 12h16a8 8 0 0 1-16 0z"/><path d="M8.5 20h7M14 4l-3 6M18 5l-4 5"/>',
    bus: '<rect x="5" y="4" width="14" height="13" rx="2.5"/><path d="M5 11h14M8 17v2.5M16 17v2.5M8.5 14h.01M15.5 14h.01"/>',
    people:
      '<circle cx="9" cy="9" r="3"/><path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/><circle cx="16.5" cy="10" r="2.4"/><path d="M15.5 14.6c2.6-.3 4.4 1.2 5 4.4"/>',
    flame: '<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.4 1.2-3.8 2.4-5 .2 1.6 1 2.6 2 3 0-3 .2-5.5.6-8z"/>',
    droplet: '<path d="M12 3.5c3 4 6 7.2 6 10.5a6 6 0 0 1-12 0c0-3.3 3-6.5 6-10.5z"/>',
    washer: '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M5 8h14M8 5.8h.01M10.5 5.8h.01"/><circle cx="12" cy="14" r="3.5"/>',
    tag: '<path d="M3.5 12.5V4.5h8l9 9-8 8z"/><circle cx="8" cy="9" r="1.3"/>',
    building: '<path d="M5 20V5.5L13 3.5V20M13 9l6 2v9M3.5 20h17M8 8h2M8 11.5h2M8 15h2"/>',
    phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 17.5h2"/>',
    wifi: '<path d="M3.5 9.5a12 12 0 0 1 17 0M6.5 12.8a7.5 7.5 0 0 1 11 0M9.5 16a3 3 0 0 1 5 0M12 19h.01"/>',
    dumbbell: '<path d="M6.5 8v8M17.5 8v8M3.5 10v4M20.5 10v4M6.5 12h11"/>',
    bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
    plane: '<path d="M10.5 4.5 13 10l6-.5a1.6 1.6 0 0 1 0 3.2l-6-.5-2.5 5.5H8.5l1.2-5.7-4.2-.4L4 13.5H2.8l.6-2.5-.6-2.5H4l1.5 1.9 4.2-.4-1.2-5.5z"/>',
    camera: '<path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
    arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
    repeat: '<path d="M17 3.5 20 6.5l-3 3"/><path d="M4 12v-1.5a4 4 0 0 1 4-4h12M7 20.5 4 17.5l3-3"/><path d="M20 12v1.5a4 4 0 0 1-4 4H4"/>',
  };
  return `<svg class="ui-icon ${extra}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ""}</svg>`;
}
// Picture and colour for each category: by id for the built-in ones, by name for categories you add.
const CATEGORY_VISUALS = {
  food: ["food", "orange"],
  "dating-social": ["people", "pink"],
  transport: ["bus", "blue"],
  gas: ["flame", "amber"],
  water: ["droplet", "cyan"],
  household: ["washer", "teal"],
  misc: ["tag", "slate"],
  rent: ["building", "indigo"],
  sim: ["phone", "violet"],
  wifi: ["wifi", "sky"],
  gym: ["dumbbell", "green"],
  "electricity-bill": ["bolt", "amber"],
  "travel-expense": ["plane", "sky"],
  "equipment-purchase": ["camera", "slate"],
  "project-shortfall": ["project", "slate"],
};
const CATEGORY_KEYWORDS = [
  [/icloud|apple one|netflix|spotify|youtube|disney|prime video|google one|chatgpt|claude|subscription|streaming/i, "repeat", "indigo"],
  [/family|parent|mom|mother|dad|father|support|remit|allowance/i, "heart", "red"],
  [/food|grocer|meal|restaurant|lunch|dinner|coffee|snack/i, "food", "orange"],
  [/transport|mrt|metro|bus|taxi|uber|train|commute/i, "bus", "blue"],
  [/social|dating|friend|gift|party/i, "people", "pink"],
  [/household|laundry|toilet|clean|home supplies/i, "washer", "teal"],
  [/rent|housing|mortgage/i, "building", "indigo"],
  [/phone|sim|mobile/i, "phone", "violet"],
  [/internet|wifi|wi-fi|broadband/i, "wifi", "sky"],
  [/gym|fitness|sport|workout/i, "dumbbell", "green"],
  [/electric|power/i, "bolt", "amber"],
  [/gas|fuel/i, "flame", "amber"],
  [/water/i, "droplet", "cyan"],
  [/travel|trip|flight|hotel/i, "plane", "sky"],
  [/equipment|camera|gear|device/i, "camera", "slate"],
];
function categoryVisual(c) {
  if (!c) return { icon: "tag", tone: "slate" };
  const known = CATEGORY_VISUALS[c.id];
  if (known) return { icon: known[0], tone: known[1] };
  const hit = CATEGORY_KEYWORDS.find(([re]) => re.test(c.name || ""));
  return hit ? { icon: hit[1], tone: hit[2] } : { icon: "tag", tone: "slate" };
}
function catIcon(v, size = "") {
  return `<span class="cat-ic t-${v.tone}${size ? ` ${size}` : ""}" aria-hidden="true">${icon(v.icon)}</span>`;
}
function txVisual(x) {
  if (x._kind === "income") return { icon: "income", tone: "green" };
  if (x._kind === "transfer") return { icon: "transfer", tone: "slate" };
  return categoryVisual(category(x.categoryId));
}
const SHORT_CATEGORY_NAMES = {
  Transportation: "Transport",
  Miscellaneous: "Misc",
  "Electricity Bill": "Electricity",
  "Travel Expense": "Travel",
  "Equipment Purchase": "Equipment",
};
function latestReconciliation(accountId) {
  return (
    [...state.reconciliations]
      .filter((r) => r.accountId === accountId && !r.deletedAt)
      .sort((a, b) => `${a.date || ""}${a.createdAt || ""}`.localeCompare(`${b.date || ""}${b.createdAt || ""}`))
      .at(-1) || null
  );
}
function recordAfterReconciliation(rec, effectiveDate, stamp) {
  const rd = String(rec?.date || ""),
    ed = String(effectiveDate || "");
  if (ed > rd) return true;
  if (ed < rd) return false;
  return String(stamp || "") > String(rec?.createdAt || "");
}
function physicalDeltaSinceReconciliation(accountId, rec) {
  let delta = 0;
  for (const x of state.incomes || []) {
    if (
      !x.deletedAt &&
      x.accountId === accountId &&
      recordAfterReconciliation(rec, x.dateReceived || x.date, x.createdAt || x.updatedAt)
    )
      delta += Number(x.amount || 0);
  }
  for (const x of state.expenses || []) {
    if (
      !x.deletedAt &&
      x.accountId === accountId &&
      recordAfterReconciliation(rec, x.dateReceived || x.date, x.createdAt || x.updatedAt)
    )
      delta -= Number(x.amount || 0);
  }
  for (const t of state.transfers || []) {
    if (t.deletedAt || t.status !== "completed") continue;
    const purposeOnly =
      t.affectsPhysicalBalance === false ||
      t.fromAccountId === t.toAccountId ||
      ["bucket_allocation", "reserve_allocation"].includes(t.transferType);
    if (
      purposeOnly ||
      !recordAfterReconciliation(rec, t.completedDate || t.plannedDate, t.completedAt || t.updatedAt || t.createdAt)
    )
      continue;
    if (t.toAccountId === accountId) delta += Number(t.amount || 0);
    if (t.fromAccountId === accountId) delta -= Number(t.amount || 0);
  }
  for (const a of state.adjustments || []) {
    if (!a.deletedAt && a.accountId === accountId && recordAfterReconciliation(rec, a.date, a.createdAt || a.updatedAt))
      delta += Number(a.amount || 0);
  }
  return delta;
}
function accountSnapshot(accountId) {
  const rawExpected = Number(state.accountBalances[accountId] || 0);
  const rec = latestReconciliation(accountId);
  if (!rec)
    return {
      accountId,
      expected: rawExpected,
      rawExpected,
      actual: rawExpected,
      difference: 0,
      verified: false,
      reconciliation: null,
      isEstimated: false,
      ledgerDeltaSinceCheck: 0,
    };
  // The exact bank check is the authoritative baseline. Only physical activity that
  // occurred after that check is allowed to roll the balance forward. Historical
  // adjustments that helped reach the checked balance are therefore never counted twice.
  const ledgerDeltaSinceCheck = physicalDeltaSinceReconciliation(accountId, rec);
  const tracked = Number(rec.actualBalance || 0) + ledgerDeltaSinceCheck;
  return {
    accountId,
    expected: tracked,
    rawExpected,
    actual: tracked,
    difference: 0,
    verified: true,
    reconciliation: rec,
    isEstimated: Math.abs(ledgerDeltaSinceCheck) >= 0.5,
    ledgerDeltaSinceCheck,
  };
}
function esunSnapshot() {
  const base = accountSnapshot("esun");
  const virtualTotal = state.buckets
    .filter((b) => b.accountId === "esun")
    .reduce((sum, b) => sum + Number(state.bucketBalances[b.id] || 0), 0);
  const unassigned = base.actual - virtualTotal;
  return {
    ...base,
    virtualTotal,
    unassigned,
    allocationOk: Math.abs(unassigned) < 0.5,
    bankOk: Math.abs(base.difference) < 0.5,
  };
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((new Date() - d) / 86400000));
}
function duplicateGroups(records, keyFn) {
  const groups = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
function dataHealthReport() {
  const issues = [];
  const add = (severity, title, detail, action = null) => issues.push({ severity, title, detail, action });
  const ct = accountSnapshot("ctbc"),
    es = esunSnapshot();
  if (!ct.verified)
    add(
      "warn",
      "CTBC has no verified bank baseline",
      "Update the CTBC balance from your bank app so the ledger has an authoritative starting point.",
      "ctbc",
    );
  if (ct.verified && Math.abs(ct.difference) >= 0.5)
    add(
      "critical",
      "CTBC does not reconcile",
      `Bank vs ledger differs by ${ct.difference > 0 ? "+" : ""}${money(ct.difference)}.`,
      "ctbc",
    );
  if (!es.verified)
    add("warn", "E.SUN has no verified bank baseline", "Update the E.SUN balance from your bank app.", "esun");
  if (es.verified && !es.bankOk)
    add(
      "critical",
      "E.SUN bank ledger mismatch",
      `Bank vs ledger differs by ${es.difference > 0 ? "+" : ""}${money(es.difference)}.`,
      "esun",
    );
  if (!es.allocationOk)
    add(
      "critical",
      "E.SUN purpose allocation mismatch",
      es.unassigned > 0
        ? `${money(es.unassigned)} is unassigned.`
        : `Virtual buckets exceed tracked E.SUN cash by ${money(Math.abs(es.unassigned))}.`,
      "esun",
    );
  const cash = accountSnapshot("cash");
  if (cash.actual < -0.5)
    add(
      "critical",
      "Cash Wallet is negative",
      `${money(cash.actual)} means recorded cash spending exceeds recorded ATM withdrawals/deposits. Review cash activity.`,
      "cash",
    );
  for (const [id, label] of [
    ["ctbc", "CTBC"],
    ["esun", "E.SUN"],
    ["cash", "Cash Wallet"],
  ]) {
    const rec = latestReconciliation(id),
      age = daysSince(rec?.date);
    if (age !== null && age > 45)
      add(
        "warn",
        `${label} reconciliation is ${age} days old`,
        "Consider confirming the bank balance before month close.",
        id,
      );
  }
  const pending = state.transfers.filter((t) => !t.deletedAt && t.status === "planned");
  if (pending.length)
    add(
      "warn",
      `${pending.length} planned transfer${pending.length === 1 ? "" : "s"} still pending`,
      "Planned transfers do not affect balances until completed or deleted.",
    );
  const unrouted = state.incomes.filter(
    (i) =>
      !i.deletedAt &&
      i.incomeType !== "regular_income" &&
      i.incomeType !== "reimbursement" &&
      !i.routingHandled &&
      !routingTransfersForIncome(i.id).length,
  );
  if (unrouted.length)
    add(
      "warn",
      `${unrouted.length} supplemental income record${unrouted.length === 1 ? " needs" : "s need"} routing`,
      "Open the funding month or Activity and decide whether the money stays in operating cash, funds a goal, or goes to investments.",
    );
  for (const p of state.projects.filter((x) => !x.deletedAt && !projectSettlement(x.id))) {
    const missing = projectMissingTwd(p.id);
    if (missing.length)
      add(
        "warn",
        `${p.title}: ${missing.length} expense${missing.length === 1 ? " needs" : "s need"} NTD value`,
        "Project settlement is blocked until each expense has an NTD equivalent.",
      );
  }
  for (const st of state.projectSettlements.filter(
    (x) => !x.deletedAt && Number(x.cardPaidTwd || 0) > 0.5 && !x.cardClearingConfirmed,
  )) {
    const p = project(st.projectId);
    add(
      "warn",
      `${p?.title || "Project"} card funding not confirmed`,
      `${money(st.cardPaidTwd)} of E.SUN card-paid project costs still need CTBC → E.SUN funding confirmation.`,
    );
  }
  const negative = state.buckets.filter((b) => Number(state.bucketBalances[b.id] || 0) < -0.5);
  for (const b of negative)
    add(
      "critical",
      `${b.name} is negative`,
      `${money(state.bucketBalances[b.id])} indicates a reserve/bucket was used beyond its recorded funding.`,
    );
  const expDup = duplicateGroups(
    state.expenses.filter((x) => !x.deletedAt),
    (x) =>
      [x.date, Number(x.amount || 0), x.categoryId, x.accountId, (x.description || "").trim().toLowerCase()].join("|"),
  );
  const incDup = duplicateGroups(
    state.incomes.filter((x) => !x.deletedAt),
    (x) =>
      [
        x.dateReceived,
        Number(x.amount || 0),
        x.incomeType,
        x.accountId,
        (x.description || "").trim().toLowerCase(),
      ].join("|"),
  );
  const trDup = duplicateGroups(
    state.transfers.filter((x) => !x.deletedAt),
    (x) =>
      [
        x.completedDate || x.plannedDate,
        Number(x.amount || 0),
        x.fromAccountId,
        x.toAccountId,
        x.transferType,
        x.status,
      ].join("|"),
  );
  const dupCount = expDup.length + incDup.length + trDup.length;
  if (dupCount)
    add(
      "warn",
      `${dupCount} possible duplicate record group${dupCount === 1 ? "" : "s"}`,
      "These are exact same-day/same-amount matches. Review Activity before deleting anything.",
    );
  const currentMonth = today().slice(0, 7);
  for (const p of state.periods.filter((p) => p.state !== "closed" && p.id < currentMonth))
    add(
      "warn",
      `${monthLabel(p.id)} is still open`,
      "Review, reconcile, sweep and close old funding months so history remains clean.",
    );
  const lastBackup = state.settings.lastBackupAt ? new Date(state.settings.lastBackupAt) : null;
  const backupAge = lastBackup ? Math.floor((Date.now() - lastBackup.getTime()) / 86400000) : null;
  if (backupAge === null)
    add("info", "No JSON backup recorded", "Export a backup before major corrections or device changes.");
  else if (backupAge > 30) add("info", `Backup is ${backupAge} days old`, "Export a fresh JSON backup.");
  const closedWithoutSnapshot = state.periods.filter(
    (p) =>
      p.state === "closed" &&
      !state.monthlyCloses.some((c) => (c.id === p.id || c.budgetPeriodId === p.id) && c.status === "closed"),
  );
  for (const p of closedWithoutSnapshot)
    add(
      "critical",
      `${monthLabel(p.id)} is closed without a close snapshot`,
      "Reopen and close the month again to rebuild the historical snapshot.",
    );
  const severityRank = { critical: 0, warn: 1, info: 2 };
  issues.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  return {
    issues,
    critical: issues.filter((x) => x.severity === "critical").length,
    warn: issues.filter((x) => x.severity === "warn").length,
    info: issues.filter((x) => x.severity === "info").length,
    healthy: !issues.some((x) => x.severity === "critical" || x.severity === "warn"),
  };
}
function dataHealthView() {
  const r = dataHealthReport();
  const status = r.healthy
    ? "Healthy"
    : r.critical
      ? `${r.critical} critical issue${r.critical === 1 ? "" : "s"}`
      : `${r.warn} warning${r.warn === 1 ? "" : "s"}`;
  const summaryClass = r.critical ? "danger-notice" : r.warn ? "" : "good-notice";
  const items = r.issues.length
    ? r.issues
        .map(
          (x) =>
            `<div class="health-item ${x.severity}"><span class="health-dot">${x.severity === "critical" ? "!" : x.severity === "warn" ? "!" : "i"}</span><div><strong>${esc(x.title)}</strong><div class="sub">${esc(x.detail)}</div>${x.action ? `<button class="text-btn" data-action="account-audit" data-id="${x.action}">Open ${esc(physicalAccount(x.action)?.name || x.action)} audit</button>` : ""}</div></div>`,
        )
        .join("")
    : `<div class="empty compact-empty"><strong>No data-health issues found.</strong><span>Accounts, virtual buckets and month states are internally consistent.</span></div>`;
  return `<div class="notice ${summaryClass}"><strong>${esc(status)}</strong><br>Data Health looks for reconciliation gaps, stale checks, negative buckets, exact duplicate patterns, pending transfers and month-state problems. It never changes data automatically.</div><section class="card health-list" style="margin-top:14px">${items}</section><div class="sub" style="margin-top:12px">Last evaluated live from the records currently stored on this device.</div>`;
}

function allocationsForTransfer(transferId) {
  return state.transferAllocations.filter((a) => a.transferId === transferId);
}
function accountAudit(accountId) {
  const a = physicalAccount(accountId),
    rec = latestReconciliation(accountId);
  const baseline = rec ? Number(rec.actualBalance || 0) : Number(a?.openingBalance || 0);
  const baselineDate = rec?.date || null;
  const include = (date, stamp) => !rec || recordAfterReconciliation(rec, date, stamp);
  const entries = [];
  for (const x of state.incomes.filter((x) => !x.deletedAt && x.accountId === accountId)) {
    const date = x.dateReceived || x.date;
    if (include(date, x.createdAt || x.updatedAt))
      entries.push({
        date,
        stamp: x.createdAt || x.updatedAt || "",
        type: "Income",
        detail: x.description || INCOME_TYPES.find((t) => t[0] === x.incomeType)?.[1] || "Income",
        delta: Number(x.amount || 0),
        recordId: x.id,
      });
  }
  for (const x of state.expenses.filter((x) => !x.deletedAt && x.accountId === accountId)) {
    if (include(x.date, x.createdAt || x.updatedAt))
      entries.push({
        date: x.date,
        stamp: x.createdAt || x.updatedAt || "",
        type: "Expense",
        detail: x.description || category(x.categoryId)?.name || "Expense",
        delta: -Number(x.amount || 0),
        recordId: x.id,
      });
  }
  for (const t of state.transfers.filter(
    (t) => !t.deletedAt && t.status === "completed" && !isPurposeOnlyTransfer(t),
  )) {
    const date = t.completedDate || t.plannedDate,
      stamp = t.completedAt || t.updatedAt || t.createdAt || "";
    if (!include(date, stamp)) continue;
    if (t.toAccountId === accountId)
      entries.push({
        date,
        stamp,
        type: "Bank transfer in",
        detail: `From ${physicalAccount(t.fromAccountId)?.name || t.fromAccountId}`,
        delta: Number(t.amount || 0),
        recordId: t.id,
      });
    if (t.fromAccountId === accountId)
      entries.push({
        date,
        stamp,
        type: "Bank transfer out",
        detail: `To ${physicalAccount(t.toAccountId)?.name || t.toAccountId}`,
        delta: -Number(t.amount || 0),
        recordId: t.id,
      });
  }
  for (const x of state.adjustments.filter((x) => !x.deletedAt && x.accountId === accountId)) {
    if (include(x.date, x.createdAt || x.updatedAt))
      entries.push({
        date: x.date,
        stamp: x.createdAt || x.updatedAt || "",
        type: "Adjustment",
        detail: x.note || "Account adjustment",
        delta: Number(x.amount || 0),
        recordId: x.id,
      });
  }
  entries.sort(
    (x, y) =>
      String(x.date || "").localeCompare(String(y.date || "")) ||
      String(x.stamp || "").localeCompare(String(y.stamp || "")),
  );
  let running = baseline;
  for (const e of entries) {
    running += e.delta;
    e.running = running;
  }
  const accountBucketIds = new Set(state.buckets.filter((b) => b.accountId === accountId).map((b) => b.id));
  const purposeEvents = state.transfers
    .filter(
      (t) =>
        !t.deletedAt &&
        t.status === "completed" &&
        allocationsForTransfer(t.id).some((a) => accountBucketIds.has(a.bucketId)),
    )
    .map((t) => ({
      transfer: t,
      allocations: allocationsForTransfer(t.id).filter((a) => accountBucketIds.has(a.bucketId)),
      reversedBy: state.transfers.find((r) => !r.deletedAt && r.reversalOf === t.id) || null,
    }))
    .sort(
      (x, y) =>
        String(y.transfer.completedDate || y.transfer.plannedDate || "").localeCompare(
          String(x.transfer.completedDate || x.transfer.plannedDate || ""),
        ) || String(y.transfer.createdAt || "").localeCompare(String(x.transfer.createdAt || "")),
    );
  return { account: a, reconciliation: rec, baseline, baselineDate, entries, tracked: running, purposeEvents };
}
function canReversePurposeEvent(event) {
  const t = event?.transfer;
  if (!t || event.reversedBy || t.systemGenerated || t.reversalOf) return false;
  return isPurposeOnlyTransfer(t) && event.allocations.length > 0;
}
function completedAllocationToBucket(periodId, bucketId) {
  const complete = new Set(
    state.transfers
      .filter((t) => t.status === "completed" && !t.deletedAt && t.budgetPeriodId === periodId)
      .map((t) => t.id),
  );
  return state.transferAllocations
    .filter((a) => complete.has(a.transferId) && a.bucketId === bucketId)
    .reduce((s, a) => s + Number(a.amount || 0), 0);
}
function completedTithe(periodId) {
  return completedAllocationToBucket(periodId, "tithe");
}
function expectedTithe(periodId) {
  return Math.round((periodEligibleIncome(periodId) * Number(state.settings.tithePercent || 10)) / 100);
}
function paydayRequirements(periodId) {
  const p = state.periods.find((x) => x.id === periodId);
  if (!p) return { groups: [], totalOutstanding: 0, items: [] };
  const plan = planFor(periodId);

  // Reconstruct the goal-routing state from before this funding month's completed
  // allocations so already-completed contributions do not change the original plan.
  const preBalances = { ...state.bucketBalances };
  for (const b of state.buckets) {
    preBalances[b.id] = Number(preBalances[b.id] || 0) - completedAllocationToBucket(periodId, b.id);
  }
  const goalAllocs = Array.isArray(p.paydayRoutingSnapshot?.goalAllocs)
    ? p.paydayRoutingSnapshot.goalAllocs
    : allocateGoalSurplus({
        amount: Math.max(0, Math.round(plan.immediateWealth)),
        goals: state.goals,
        bucketBalances: preBalances,
      });

  const intended = [];
  if (Number(plan.tithe || 0) > 0)
    intended.push({ bucketId: "tithe", amount: Math.round(Number(plan.tithe)), label: "Tithe" });
  for (const a of goalAllocs) {
    if (a.bucketId)
      intended.push({
        bucketId: a.bucketId,
        amount: Number(a.amount || 0),
        label: a.label || bucket(a.bucketId)?.name || "Goal",
      });
  }

  const byDest = new Map();
  for (const item of intended) {
    const b = bucket(item.bucketId);
    if (!b?.accountId) continue;
    const completed = completedAllocationToBucket(periodId, item.bucketId);
    const remaining = Math.max(0, Number(item.amount || 0) - completed);
    if (remaining <= 0.5) continue;
    if (!byDest.has(b.accountId)) byDest.set(b.accountId, []);
    byDest.get(b.accountId).push({ ...item, remaining, accountId: b.accountId });
  }

  const investmentTarget = goalAllocs
    .filter((a) => a.accountId === "ibkr")
    .reduce((sum, a) => sum + Number(a.amount || 0), 0);
  const completedInvestment = state.transfers
    .filter(
      (t) =>
        !t.deletedAt &&
        t.status === "completed" &&
        t.budgetPeriodId === periodId &&
        t.toAccountId === "ibkr" &&
        t.fromAccountId !== "ibkr",
    )
    .reduce((sum, t) => sum + Number(t.amount || 0), 0);
  const investmentRemaining = Math.max(0, investmentTarget - completedInvestment);
  if (investmentRemaining > 0.5) {
    if (!byDest.has("ibkr")) byDest.set("ibkr", []);
    byDest
      .get("ibkr")
      .push({
        bucketId: null,
        amount: investmentTarget,
        remaining: investmentRemaining,
        label: "Investment contribution",
        accountId: "ibkr",
      });
  }

  const groups = [...byDest.entries()]
    .map(([accountId, items]) => ({
      accountId,
      items,
      amount: items.reduce((sum, x) => sum + Number(x.remaining || 0), 0),
    }))
    .filter((g) => g.amount > 0.5);
  return {
    groups,
    totalOutstanding: groups.reduce((sum, g) => sum + g.amount, 0),
    items: groups.flatMap((g) => g.items),
  };
}
function actualAccountValue(accountId) {
  const a = physicalAccount(accountId);
  if (!a) return 0;
  if (a.role === "investment") return Number(state.accountBalances[accountId] || 0);
  const snap = accountSnapshot(accountId);
  return snap.actual;
}

function applyPrivacyMask() {
  if (!state.settings?.privacyMode) return;
  const detect = /(NT\$|US\$|\$)\s*-?[\d,]+(?:\.\d+)?/;
  const replace = /(NT\$|US\$|\$)\s*-?[\d,]+(?:\.\d+)?/g;
  const nodes = new Set();
  const collect = (scope) => {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || ["SCRIPT", "STYLE", "INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(p.tagName))
          return NodeFilter.FILTER_REJECT;
        return detect.test(node.nodeValue || "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) nodes.add(walker.currentNode);
  };
  root.querySelectorAll(".privacy-sensitive,.privacy-all-money").forEach(collect);
  for (const node of nodes) node.nodeValue = (node.nodeValue || "").replace(replace, "$1••••");
}

// v1.16: what the last redraw showed, so bars move only when something changed and the pop-up slides in
// only when it opens (not on every redraw while it's open).
let lastShell = { tab: null, period: null, modal: false },
  pendingHighlight = null;
function shell(content) {
  const before = snapshotBars(root),
    entering = lastShell.tab !== tab || lastShell.period !== selectedPeriodId,
    modalOpening = !!modal && !lastShell.modal;
  const footer =
    tab === "transactions"
      ? ""
      : '<p class="footer-note">Local-first financial planning. Transfers are not expenses; virtual buckets track purpose independently of bank balances.</p>';
  const hidden = state.settings?.privacyMode === true;
  const hour = new Date().getHours(),
    greeting = hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 18 ? "Good afternoon" : "Good evening";
  const titles = { budget: "Budget", transactions: "Activity", wealth: "Wealth", goals: "Wealth", forecast: "Wealth" };
  const brand = `<div class="brand home-brand"><span class="brand-kicker">Wealth OS</span><h1>${tab === "home" ? greeting : titles[tab] || "Wealth OS"}</h1></div>`;
  root.innerHTML = `<main class="shell">
    <header class="topbar">${brand}<div class="topbar-actions"><button class="btn ghost small privacy-btn" data-action="privacy-toggle" aria-label="${hidden ? "Show" : "Hide"} sensitive balances" aria-pressed="${hidden}">${icon(hidden ? "eyeOff" : "eye")}<span>${hidden ? "Show" : "Hide"}</span></button><button class="btn ghost small settings-btn" data-action="settings" aria-label="Settings">${icon("settings")}<span>Settings</span></button></div></header>
    ${content}
    ${footer}
  </main>${nav()}${modal ? renderModal() : ""}`;
  applyPrivacyMask();
  bind();
  linkFieldLabels();
  modalDirty = false;
  root.querySelector(".modal")?.addEventListener("input", () => (modalDirty = true));
  lastShell = { tab, period: selectedPeriodId, modal: !!modal };
  if (modalOpening && motionAllowed()) root.querySelector(".modal-backdrop")?.classList.add("modal-enter");
  animateBars(root, before, entering);
  if (pendingHighlight) {
    root.querySelector(`[data-entry="${pendingHighlight}"]`)?.classList.add("entry-just-saved");
    pendingHighlight = null;
  }
}
// Connect each form label to its field so screen readers announce what the field is for.
function linkFieldLabels() {
  let n = 0;
  root.querySelectorAll(".field").forEach((f) => {
    const label = f.querySelector(":scope > label"),
      control = f.querySelector("input:not([type=hidden]), select, textarea");
    if (!label || !control || label.htmlFor) return;
    if (!control.id) control.id = `field-${++n}`;
    label.htmlFor = control.id;
  });
}
// Bottom bar (v1.13): Home · Budget · + · Activity · Wealth. Goals and Insights live inside Wealth.
const WEALTH_TABS = ["wealth", "goals", "forecast"];
function nav() {
  const button = ([id, ic, label]) => {
    const active = id === "wealth" ? WEALTH_TABS.includes(tab) : tab === id;
    return `<button class="tab ${active ? "active" : ""}" data-tab="${id}" aria-label="${label}"${active ? ' aria-current="page"' : ""}><span class="tab-icon">${icon(ic)}</span><span class="tab-label">${label}</span></button>`;
  };
  const add = `<button class="tab tab-add" data-action="new-entry" aria-label="Add an expense, income or transfer"><span class="tab-icon"><span class="tab-add-circle">${icon("plus")}</span></span><span class="tab-label" aria-hidden="true">Add</span></button>`;
  return `<nav class="tabs" aria-label="Main"><div class="tabs-inner">${button(["home", "home", "Home"])}${button(["budget", "pie", "Budget"])}${add}${button(["transactions", "activity", "Activity"])}${button(["wealth", "wealth", "Wealth"])}</div></nav>`;
}
function wealthSwitch() {
  return `<div class="theme-switch wealth-switch" role="group" aria-label="Wealth sections">${[
    ["wealth", "Overview"],
    ["goals", "Goals"],
    ["forecast", "Insights"],
  ]
    .map(
      ([id, label]) =>
        `<button type="button" class="theme-option ${tab === id ? "active" : ""}" data-tab="${id}" aria-pressed="${tab === id}">${label}</button>`,
    )
    .join("")}</div>`;
}

function periodSelector(full = false) {
  if (!state.periods.length) return "";
  const ordered = [...state.periods].sort((a, b) => a.id.localeCompare(b.id)),
    idx = ordered.findIndex((p) => p.id === selectedPeriodId),
    older = idx > 0 ? ordered[idx - 1] : null,
    newer = idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1] : null;
  const current = ordered[idx],
    stateLabel = (x) => (x.state === "closed" ? "Closed" : x.state === "reopened" ? "Reopened" : "Open");
  return `<div class="period-nav${full ? " full" : ""}"><button class="period-step" data-action="period-step" data-id="${older?.id || ""}" ${older ? "" : "disabled"} aria-label="Older funding month">‹</button><label class="period-current"><span class="period-name">${current ? monthLabel(current.id) : "Choose month"}</span>${current ? `<span class="tag period-state ${current.state === "closed" ? "" : "good-tag"}">${stateLabel(current)}</span>` : ""}<select id="period-select" aria-label="Funding month">${[
    ...ordered,
  ]
    .reverse()
    .map(
      (p) =>
        `<option value="${p.id}" ${p.id === selectedPeriodId ? "selected" : ""}>${monthLabel(p.id)} · ${stateLabel(p)}</option>`,
    )
    .join(
      "",
    )}</select></label><button class="period-step" data-action="period-step" data-id="${newer?.id || ""}" ${newer ? "" : "disabled"} aria-label="Newer funding month">›</button></div>`;
}

// "Oct 4" this year, "Oct 4, 2025" otherwise; anything that isn't a date is shown as is.
function dayLabel(iso) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso || "")) return iso || "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number),
    opts = { month: "short", day: "numeric", ...(y !== new Date().getFullYear() ? { year: "numeric" } : {}) };
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(y, m - 1, d));
}
function render() {
  if (tab === "home") return shell(homeView());
  if (tab === "budget") return shell(budgetView());
  if (tab === "transactions") return shell(transactionsView());
  if (tab === "goals") return shell(wealthSwitch() + goalsView());
  if (tab === "wealth") return shell(wealthSwitch() + wealthView());
  if (tab === "forecast") return shell(wealthSwitch() + forecastView());
}

// ---------- Home week strip (v1.17) ----------
// Seven days of the month you're looking at, each with what went on everyday flexible spending (bills that
// arrive irregularly, like gas and water, are left out) against an even daily share of those caps.
const isoDay = (d) => today(d);
function addDaysIso(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return isoDay(new Date(y, m - 1, d + n, 12));
}
function mondayOf(iso) {
  const [y, m, d] = iso.split("-").map(Number),
    dow = new Date(y, m - 1, d, 12).getDay();
  return addDaysIso(iso, dow === 0 ? -6 : 1 - dow);
}
function weekStripHTML(p, fp) {
  const [y, m] = p.id.split("-").map(Number),
    first = `${p.id}-01`,
    last = isoDay(new Date(y, m, 0, 12));
  const dailyLines = fp.capLines.filter((l) => !isIrregularCap(l));
  if (!dailyLines.length) return "";
  const ids = new Set(dailyLines.map((l) => l.id)),
    dailyBudget = dailyLines.reduce((n, l) => n + Number(l.budgetAmount || 0), 0),
    pace = fp.ctx.days ? dailyBudget / fp.ctx.days : 0;
  const ref = today() < first ? first : today() > last ? last : today();
  if (!homeWeekStart || homeWeekStart > last || addDaysIso(homeWeekStart, 6) < first) {
    homeWeekStart = mondayOf(ref);
    homeDay = null;
  }
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(homeWeekStart, i));
  const spentOn = (d) =>
    state.expenses
      .filter((e) => !e.deletedAt && e.budgetPeriodId === p.id && e.date === d && ids.has(e.categoryId))
      .reduce((n, e) => n + Number(e.amount || 0), 0);
  const amounts = days.map(spentOn),
    scale = Math.max(pace * 1.8, ...amounts, 1),
    weekTotal = amounts.reduce((a, b) => a + b, 0);
  const prev = addDaysIso(homeWeekStart, -7),
    next = addDaysIso(homeWeekStart, 7),
    canPrev = addDaysIso(prev, 6) >= first,
    canNext = next <= last;
  const fmt = (d, o) => new Intl.DateTimeFormat("en-US", o).format(new Date(`${d}T12:00:00`));
  const range = `${fmt(days[0], { month: "short", day: "numeric" })} – ${fmt(days[6], { month: "short", day: "numeric" })}`;
  const bars = days
    .map((d, i) => {
      const inMonth = d >= first && d <= last,
        amt = amounts[i],
        future = d > today(),
        over = pace > 0 && amt > pace + 0.5,
        label = `${fmt(d, { weekday: "long", month: "short", day: "numeric" })}: ${money(amt)} flexible spending${over ? ", over the daily share" : ""}`;
      return `<button type="button" class="week-day${over ? " over" : ""}${d === today() ? " today" : ""}${d === homeDay ? " selected" : ""}${future ? " future" : ""}" ${inMonth ? `data-action="home-day" data-day="${d}"` : "disabled"} aria-pressed="${d === homeDay}" aria-label="${esc(label)}"><span class="week-col"><span class="week-fill" data-bar="day-${d}" data-axis="y" style="height:${((amt / scale) * 100).toFixed(1)}%"></span></span><span class="week-dow">${fmt(d, { weekday: "narrow" })}</span><span class="week-date">${Number(d.slice(8))}</span></button>`;
    })
    .join("");
  return `<div class="week-strip"><div class="week-head"><div><strong>${range}</strong><span>${money(weekTotal)} spent · on pace at ${money(pace)} a day</span></div><div class="week-nav"><button type="button" class="period-step" data-action="home-week" data-start="${prev}" ${canPrev ? "" : "disabled"} aria-label="Previous week">‹</button><button type="button" class="period-step" data-action="home-week" data-start="${next}" ${canNext ? "" : "disabled"} aria-label="Next week">›</button></div></div><div class="week-bars" style="--pace:${(pace / scale).toFixed(3)}">${bars}<span class="week-pace" aria-hidden="true"></span></div></div>`;
}
// The picked day's entries, with what was spent and received.
function homeDayList(p, day) {
  const items = activityRecords().filter((x) => x.budgetPeriodId === p.id && String(x._date || "").slice(0, 10) === day);
  if (!items.length) return `<div class="empty compact-empty"><strong>Nothing recorded on this day.</strong><span>Tap + to add an entry.</span></div>`;
  const spent = items.filter((x) => x._kind === "expense").reduce((n, x) => n + Math.abs(Number(x._amount || 0)), 0);
  return `${items
    .map(
      (x) =>
        `<div class="home-tx" data-entry="${x._kind}:${esc(x.id)}">${catIcon(txVisual(x))}<div class="home-tx-copy"><strong>${esc(x._title)}</strong><span>${esc([x.description, x._account].filter(Boolean).join(" · "))}</span></div><span class="amount ${x._kind === "income" ? "good" : ""}">${money(x._amount)}</span></div>`,
    )
    .join("")}${spent ? `<div class="home-day-total"><span>Spent this day</span><strong>${money(spent)}</strong></div>` : ""}`;
}
function homeView() {
  const p = currentPeriod();
  const active = activeGoal(state.goals, state.bucketBalances);
  const nonCore = state.wealth.financialNetWorth - state.wealth.coreWealth;
  if (!p) {
    return `<section class="card hero-action"><div class="metric-label">Start here</div><div class="metric">Create your first funding month</div><p class="sub">Enter the exact paycheck that lands in your account. Wealth OS will allocate it using your rules.</p><button class="btn" data-action="new-paycheck">Enter Paycheck</button></section>${wealthStrip()}`;
  }
  const plan = planFor(p.id),
    spent = totalExpenses(p.id),
    core = completedCoreWealth(p.id),
    goalFunding = completedGoalFunding(p.id),
    contributionRate = plan.salary > 0 ? core / plan.salary : 0;
  const expTotals = expenseTotals(p.id);
  const sweep = sweepInfo(p.id);
  const payday = paydayRequirements(p.id);
  const paydayGroup = payday.groups.find((g) => g.amount > 0.5);
  const pending = state.transfers.find(
    (t) =>
      t.budgetPeriodId === p.id &&
      t.status === "planned" &&
      !["payday", "investment_contribution"].includes(t.transferType),
  );
  const unroutedSupplemental = state.incomes.find(
    (i) =>
      !i.deletedAt &&
      i.budgetPeriodId === p.id &&
      i.incomeType !== "regular_income" &&
      i.incomeType !== "reimbursement" &&
      !i.routingHandled &&
      !routingTransfersForIncome(i.id).length,
  );
  let action = "";
  let actionText = "Payday done · keep recording";
  let actionSub = `Month-end sweep so far ${privateMoney(sweep.available)}`;
  let actionMetric = "";
  let nextTone = "good";
  const hasOpenMonth = state.periods.some((x) => x.state !== "closed");
  if (p.state === "closed" && !hasOpenMonth) {
    actionText = `${monthLabel(p.id)} is closed`;
    actionSub = "Enter your next paycheck to start the next funding month.";
    nextTone = "action";
    action = `<div class="actions"><button class="btn" data-action="new-paycheck">Enter Paycheck</button><button class="btn ghost hero-ghost" data-action="reopen-period" data-id="${p.id}">Reopen ${monthLabel(p.id)}</button></div>`;
  } else if (p.state === "closed") {
    actionText = `${monthLabel(p.id)} is closed`;
    actionSub = "Period-linked records are locked until you intentionally reopen the month.";
    nextTone = "locked";
    action = `<button class="btn" data-action="reopen-period" data-id="${p.id}">Reopen Month</button>`;
  } else if (paydayGroup) {
    const destination = physicalAccount(paydayGroup.accountId)?.name || paydayGroup.accountId;
    const detail = paydayGroup.items.map((x) => `${x.label} ${money(x.remaining)}`).join(" · ");
    actionText = `Transfer to ${destination}`;
    actionSub = `${detail}. Move only this remaining amount physically, then confirm it here.`;
    actionMetric = money(paydayGroup.amount);
    nextTone = "action";
    action = `<button class="btn" data-action="payday-transfer" data-account="${paydayGroup.accountId}" data-period="${p.id}">Record Transfer Completed</button>`;
  } else if (pending) {
    actionText = `Transfer ${money(pending.amount)} pending`;
    actionSub = `Move the money physically, then confirm it here.`;
    actionMetric = money(pending.amount);
    nextTone = "action";
    action = `<button class="btn" data-action="complete-transfer" data-id="${pending.id}">Mark Transfer Completed</button>`;
  } else if (unroutedSupplemental) {
    const due = unroutedSupplemental.titheEligible
      ? Math.round((Number(unroutedSupplemental.amount || 0) * Number(state.settings.tithePercent || 10)) / 100)
      : 0;
    actionText = "Route supplemental income";
    actionSub = `${INCOME_TYPES.find((t) => t[0] === unroutedSupplemental.incomeType)?.[1] || "Supplemental income"} ${money(unroutedSupplemental.amount)}${due ? ` · tithe due ${money(due)}` : ""}. Decide what the remainder should do.`;
    actionMetric = money(unroutedSupplemental.amount);
    nextTone = "action";
    action = `<button class="btn" data-action="route-income" data-id="${unroutedSupplemental.id}">Open Routing Assistant</button>`;
  }
  const em = goal("goal-emergency");
  const eb = em ? goalBal(em) : 0;
  const ep = em ? Math.min(1, eb / em.targetAmount) : 0;
  // v1.14 Home: one wealth card, the month at a glance with today's mark, the next step, latest activity.
  const monthName = new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(`${p.id}-15T12:00:00`));
  const fp = flexPace(p, plan, expTotals),
    { ctx, capsBudget, capsSpent, fillPct, markPct, todaysMark } = fp,
    paceTone = fp.tone,
    paceText = fp.text;
  const dayPill = ctx.isCurrent ? `Day ${ctx.elapsed} of ${ctx.days}` : ctx.isPast ? (p.state === "closed" ? "Closed" : "Month ended") : "Upcoming";
  const recent = activityRecords()
    .filter((x) => x.budgetPeriodId === p.id)
    .slice(0, 5);
  const isPriority = active && em && active.id === em.id;
  const nextIcon = nextTone === "good" ? "check" : nextTone === "locked" ? "lock" : "arrowRight";
  return `<div class="period-row">${periodSelector(true)}</div>
  ${backupReminder()}
  <section class="home-hero" aria-label="Wealth summary">
    <div class="home-hero-top"><div><div class="hero-label">Core Wealth</div><div class="hero-value">${privateMoney(state.wealth.coreWealth)}</div></div>${core > 0.5 ? `<span class="hero-pill">+${privateMoney(core)} this month</span>` : ""}</div>
    <div class="hero-tiles"><div class="hero-tile"><span>Net worth</span><strong>${privateMoney(state.wealth.financialNetWorth)}</strong></div><div class="hero-tile"><span>Non-core funds</span><strong>${privateMoney(nonCore)}</strong></div></div>
    ${
      em
        ? `<div class="hero-goal"><div class="hero-goal-row"><strong>${esc(em.name || "Emergency Fund")}</strong><span>${privateMoney(eb)} of ${money(em.targetAmount)}</span></div><div class="hero-bar" role="img" aria-label="${esc(em.name || "Emergency Fund")} ${pct(ep)} funded"><span data-bar="emergency" style="width:${(ep * 100).toFixed(1)}%"></span></div><div class="hero-sub">${ep >= 1 ? "Complete" : pct(ep)}${isPriority ? " · current wealth priority" : active ? ` · priority now: ${esc(active.name)}` : ""}</div></div>`
        : ""
    }
  </section>
  <section class="card month-card">
    <div class="month-card-head"><h2>${esc(monthName)} so far</h2><span class="tag">${dayPill}</span></div>
    <div class="month-stats"><div><span>Income</span><strong>${privateMoney(plan.salary)}</strong></div><div><span>Spent</span><strong>${money(spent)}</strong></div><div><span>To wealth</span><strong class="good-text">${pct(contributionRate)}</strong></div></div>
    <div class="month-divider"></div>
    <div class="pace-head"><strong>Flexible spending</strong><span>${money(capsSpent)} of ${money(capsBudget)}</span></div>
    <div class="pace-bar" role="img" aria-label="Flexible spending ${money(capsSpent)} of ${money(capsBudget)}${ctx.isCurrent ? `; today's mark ${money(todaysMark)}` : ""}"><span class="pace-fill ${paceTone === "bad" ? "over" : ""}" data-bar="flex-pace" style="width:${fillPct.toFixed(1)}%"></span>${ctx.isCurrent && capsBudget > 0 ? `<span class="pace-mark" style="left:${markPct.toFixed(1)}%"></span>` : ""}</div>
    <div class="pace-status pace-${paceTone}">${paceTone === "good" ? icon("check") : ""}<span>${paceText}</span></div>
    ${weekStripHTML(p, fp)}
    <div class="month-actions"><button class="btn ghost small" data-action="month-close">Month-End Review</button>${newPaycheckButton()}</div>
  </section>
  <section class="card next-step next-${nextTone}">
    <div class="next-step-row"><span class="next-ic" aria-hidden="true">${icon(nextIcon)}</span><div class="next-copy"><span class="metric-label">Next step</span><strong>${actionText}</strong><span class="sub">${actionSub}</span></div>${actionMetric ? `<strong class="next-amount">${privateValue(actionMetric)}</strong>` : ""}</div>
    ${action ? `<div class="next-step-actions">${action}</div>` : ""}
  </section>
  ${
    homeDay
      ? `<div class="section-title"><h2>${esc(dayHeading(homeDay))}</h2><button class="text-btn see-all" data-action="home-day" data-day="">Show latest</button></div>`
      : `<div class="section-title"><h2>Latest activity</h2><button class="text-btn see-all" data-tab="transactions">See all</button></div>`
  }
  <section class="card home-activity">${
    homeDay
      ? homeDayList(p, homeDay)
      : recent.length
      ? recent
          .map(
            (x) =>
              `<div class="home-tx" data-entry="${x._kind}:${esc(x.id)}">${catIcon(txVisual(x))}<div class="home-tx-copy"><strong>${esc(x._title)}</strong><span>${esc([dayLabel(x._date), x._account].filter(Boolean).join(" · "))}</span></div><span class="amount ${x._kind === "income" ? "good" : ""}">${money(x._amount)}</span></div>`,
          )
          .join("")
      : `<div class="empty compact-empty"><strong>No activity in ${esc(monthName)} yet.</strong><span>Tap + to add the first one.</span></div>`
  }</section>`;
}

function backupReminder() {
  const s = state.settings || {};
  if (!state.periods.length) return "";
  const last = s.lastBackupAt ? new Date(s.lastBackupAt).getTime() : null,
    days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  if (days !== null && days < 14) return "";
  if (s.backupSnoozeUntil && new Date(s.backupSnoozeUntil).getTime() > Date.now()) return "";
  return `<section class="card backup-reminder" style="margin-top:14px"><div class="metric-label">Backup</div><strong>${days === null ? "You haven't backed up yet" : `Last backup ${days} days ago`}</strong><div class="sub">Your financial records live only on this phone. Save a copy to Files or iCloud Drive.</div><div class="actions" style="margin-top:12px"><button class="btn" data-action="export-backup">Export Backup</button><button class="btn ghost" data-action="backup-snooze">Remind me later</button></div></section>`;
}
// The next paycheck funds the next month, so it unlocks in the last 7 days of the latest
// funding month (or once that month has ended or been closed).
function paycheckWindow() {
  const latest = [...state.periods].sort((a, b) => a.id.localeCompare(b.id)).at(-1);
  if (!latest || latest.state === "closed") return { open: true };
  const [y, m] = latest.id.split("-").map(Number),
    lastDay = new Date(y, m, 0),
    opens = new Date(y, m - 1, lastDay.getDate() - 6);
  return { open: today() >= today(opens), opens, monthId: latest.id };
}
function newPaycheckButton() {
  const w = paycheckWindow();
  if (w.open) return `<button class="btn secondary" data-action="new-paycheck">New Paycheck</button>`;
  const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(w.opens);
  return `<button class="btn secondary" type="button" disabled aria-describedby="paycheck-unlock">New Paycheck</button><div class="sub paycheck-unlock" id="paycheck-unlock">Next paycheck opens ${when}, the last week of ${monthLabel(w.monthId)}.</div>`;
}
function homeQuickCapture(p) {
  const recent = activityRecords()
    .filter((x) => !p || x.budgetPeriodId === p.id)
    .slice(0, 3);
  const activeProjects = state.projects.filter((x) => !x.deletedAt && !projectSettlement(x.id));
  const projectAction =
    activeProjects.length === 1
      ? `data-action="add-project-expense" data-project="${activeProjects[0].id}"`
      : 'data-action="open-projects"';
  const projectLabel = activeProjects.length === 1 ? "Project Expense" : "Projects";
  return `<div class="section-title"><h2>Quick capture</h2><span class="sub">Common actions</span></div>
  <div class="quick-action-grid project-ready"><button class="quick-action" data-action="add-expense">${icon("expense")}<span>Expense</span></button><button class="quick-action" data-action="add-income">${icon("income")}<span>Income</span></button><button class="quick-action" data-action="manual-transfer">${icon("transfer")}<span>Transfer</span></button><button class="quick-action" ${projectAction}>${icon("project")}<span>${projectLabel}</span></button></div>
  <section class="card mini-activity">${recent.length ? recent.map((x) => `<div class="mini-activity-row"><div><strong>${esc(x._title)}</strong><div class="sub">${esc(dayLabel(x._date))} · ${esc(x._account || "")}</div></div><span class="amount ${x._kind === "expense" ? "bad" : x._kind === "income" ? "good" : ""}">${x._kind === "transfer" ? "↔ " : ""}${money(x._amount)}</span></div>`).join("") : `<div class="empty compact-empty"><strong>No activity in this month yet.</strong><span>Use the buttons above for fast entry.</span></div>`}</section>`;
}

function budgetMini(name, budget, actual) {
  const r = budget - actual;
  const u = budget ? Math.min(1, actual / budget) : 0;
  return `<div class="row"><div style="flex:1"><strong>${name}</strong><div class="progress"><span data-bar="mini-${esc(name)}" style="width:${u * 100}%"></span></div><div class="sub">${money(actual)} of ${money(budget)}</div></div><div class="amount ${r < 0 ? "bad" : ""}">${r < 0 ? `${money(-r)} over` : `${money(r)} left`}</div></div>`;
}
function row(label, value) {
  return `<div class="row"><span>${label}</span><span class="amount">${value}</span></div>`;
}
function wealthStrip() {
  const nonCore = state.wealth.financialNetWorth - state.wealth.coreWealth;
  return `<div class="grid g3 summary-grid" style="margin-top:14px"><section class="card"><div class="metric-label">Core Wealth</div><div class="metric">${privateMoney(state.wealth.coreWealth)}</div><div class="sub">Long-term wealth base</div></section><section class="card"><div class="metric-label">Financial Net Worth</div><div class="metric">${privateMoney(state.wealth.financialNetWorth)}</div><div class="sub">Tithe excluded</div></section><section class="card"><div class="metric-label">Non-Core Funds</div><div class="metric">${privateMoney(nonCore)}</div><div class="sub">Operating cash + planned-use funds</div></section></div>`;
}

function budgetView() {
  const p = currentPeriod();
  if (!p) return `<section class="card empty">Create a paycheck first.</section>`;
  const plan = planFor(p.id),
    totals = expenseTotals(p.id),
    lines = budgetSummary({ planLines: plan.lines, expenseTotals: totals });
  const reserveFunded = lines
    .filter((x) => x.ruleType === "sinking_contribution")
    .reduce((s, x) => s + completedAllocationToBucket(p.id, x.bucketId), 0);
  const titheAllocated = completedTithe(p.id),
    titheExpected = expectedTithe(p.id);
  const wealthDone = completedCoreWealth(p.id),
    wealthPlanned = Math.max(0, plan.immediateWealth);
  const sweep = sweepInfo(p.id),
    close = monthCloseStatus(p.id),
    closed = p.state === "closed";
  const fp = flexPace(p, plan, totals),
    ctx = fp.ctx;
  const dayPill = ctx.isCurrent ? `Day ${ctx.elapsed} of ${ctx.days}` : ctx.isPast ? (closed ? "Closed" : "Month ended") : "Upcoming";
  const fixedLines = lines.filter((x) => x.ruleType === "fixed"),
    paidFixed = fixedLines.filter((x) => fixedPaid(x.actual)),
    billDiff = paidFixed.reduce((sum, x) => sum + Number(x.budgetAmount || 0) - Number(x.actual || 0), 0),
    billDiffText = billDiff > 0.5 ? ` · ${money(billDiff)} under` : billDiff < -0.5 ? ` · ${money(-billDiff)} over` : "";
  const lock = closed
    ? `<div class="notice close-lock"><strong>Month closed</strong><br>${monthLabel(p.id)} is read-only. Reopen it intentionally before changing transactions or budget-linked records.</div>`
    : "";

  // Where the paycheck goes: one bar, one row per part of the plan with how it stands.
  const salary = Number(plan.salary || 0),
    status = (done, label, todo) => (done ? { tone: "good", text: label } : { tone: "warn", text: todo });
  const parts = [
    { key: "tithe", name: "Tithe", amount: plan.tithe, ...status(titheAllocated + 0.5 >= titheExpected, "Allocated", `${money(titheExpected - titheAllocated)} to allocate`) },
    { key: "fixed", name: "Fixed bills", amount: plan.fixed, tone: paidFixed.length === fixedLines.length ? "good" : "muted", text: `${paidFixed.length} of ${fixedLines.length} paid` },
    { key: "flex", name: "Flexible caps", amount: plan.caps, tone: fp.tone === "bad" ? "bad" : "muted", text: fp.capsBudget > 0 ? `${Math.round((fp.capsSpent / fp.capsBudget) * 100)}% used` : "No caps" },
    { key: "reserve", name: "Reserves", amount: plan.sinking, ...status(reserveFunded + 0.5 >= plan.sinking, "Funded", `${money(plan.sinking - reserveFunded)} to fund`) },
    { key: "buffer", name: "Operating buffer", amount: plan.buffer, tone: "muted", text: "Held" },
    { key: "wealth", name: "Wealth", amount: wealthPlanned, private: true, ...status(wealthDone + 0.5 >= wealthPlanned, "Transferred", `${money(wealthPlanned - wealthDone)} to transfer`) },
  ].filter((x) => Number(x.amount || 0) > 0.5);
  const overPlanned = Math.max(0, -Number(plan.immediateWealth || 0));
  const planCard = `<section class="card plan-card"><div class="plan-head"><h2>Where ${privateMoney(salary)} goes</h2><span class="sub">Your paycheck plan for ${monthLabel(p.id)}</span></div>${
    salary > 0
      ? `<div class="plan-bar" role="img" aria-label="${parts.map((x) => `${x.name} ${Math.round((x.amount / salary) * 100)}%`).join(", ")}">${parts.map((x) => `<span class="plan-seg k-${x.key}" data-bar="plan-${x.key}" style="width:${((x.amount / Math.max(salary, plan.assignedBeforeWealth)) * 100).toFixed(2)}%"></span>`).join("")}</div>`
      : ""
  }<div class="plan-rows">${parts
    .map(
      (x) =>
        `<div class="plan-row"><span class="plan-dot k-${x.key}" aria-hidden="true"></span><span class="plan-name">${x.name}</span><span class="plan-status st-${x.tone}">${x.text}</span><strong class="plan-amt">${x.private ? privateMoney(x.amount) : money(x.amount)}</strong></div>`,
    )
    .join("")}</div>${overPlanned > 0.5 ? `<div class="notice plan-warn">The plan assigns ${money(overPlanned)} more than this paycheck. Lower a cap or a bill in Settings → Budget rules.</div>` : ""}<div class="plan-sweep"><span>Month-end sweep so far</span><strong>${privateMoney(sweep.available)}</strong></div></section>`;

  // Fixed bills: ✓ once a payment is recorded, with the difference from the budget.
  const lastDate = (catId) =>
    state.expenses
      .filter((e) => !e.deletedAt && e.budgetPeriodId === p.id && e.categoryId === catId)
      .map((e) => e.date || "")
      .sort()
      .at(-1);
  const fixedList = fixedLines.length
    ? `<div class="section-title"><h2>Fixed bills</h2><span class="sub ${paidFixed.length === fixedLines.length ? "good-text" : ""}">${paidFixed.length} of ${fixedLines.length} paid${billDiffText}</span></div><section class="card bill-list">${fixedLines
        .map((x) => {
          const planned = Number(x.budgetAmount || 0),
            actual = Number(x.actual || 0),
            paid = fixedPaid(actual),
            diff = paid ? billDifferenceText(actual, planned) : "";
          const right = paid
            ? `<span class="bill-check" role="img" aria-label="Paid">${icon("check")}</span>`
            : closed
              ? `<span class="tag">Not recorded</span>`
              : `<button class="btn ghost small" data-action="record-fixed" data-category="${x.id}" data-amount="${planned}" aria-label="Record ${esc(x.name)} ${money(planned)}">Record</button>`;
          return `<div class="bill-row">${catIcon(categoryVisual(x))}<div class="bill-copy"><strong>${esc(x.name)}</strong><span>${paid ? `Paid ${dayLabel(lastDate(x.id))}${diff ? ` · ${diff} ${money(planned)}` : ""}` : `${money(planned)} expected`}</span></div><span class="bill-amt ${paid ? "" : "muted-amt"}">${money(paid ? actual : planned)}</span>${right}</div>`;
        })
        .join("")}</section>`
    : "";

  // Flexible caps: each with its own bar and today's mark.
  const capList = fp.capLines.length
    ? `<div class="section-title"><h2>Flexible caps</h2>${ctx.isCurrent ? `<span class="sub mark-legend"><span class="mark-swatch" aria-hidden="true"></span>today's mark</span>` : ""}</div><section class="card cap-list">${fp.capLines
        .map((x) => {
          const budget = Number(x.budgetAmount || 0),
            spent = Number(totals[x.id] || 0),
            left = budget - spent,
            pace = capPace(x, spent, ctx),
            v = categoryVisual(x),
            fill = budget > 0 ? Math.min(100, (spent / budget) * 100) : spent > 0 ? 100 : 0;
          return `<div class="cap-row"><div class="cap-top">${catIcon(v, "sm")}<div class="cap-copy"><strong>${esc(x.name)}</strong><span class="st-${pace.tone}">${pace.text}</span></div><div class="cap-nums"><strong class="${left < -0.5 ? "bad" : ""}">${money(Math.abs(left))} ${left < -0.5 ? "over" : "left"}</strong><span>${money(spent)} of ${money(budget)}</span></div></div><div class="cap-bar"><span class="cap-fill t-${v.tone}${left < -0.5 ? " over" : ""}" data-bar="cap-${x.id}" style="width:${fill.toFixed(1)}%"></span>${ctx.isCurrent && !pace.noMark && budget > 0 ? `<span class="cap-mark" style="left:${fp.markPct.toFixed(1)}%"></span>` : ""}</div></div>`;
        })
        .join("")}</section>`
    : "";

  return `<div class="period-row with-menu">${periodSelector(true)}<button type="button" class="period-step period-menu" data-action="month-actions" data-id="${p.id}" aria-label="More for ${monthLabel(p.id)}">⋯</button></div>
  ${lock}
  <section class="card ring-card">
    <div class="ring-head"><h2>Flexible spending</h2><span class="tag">${dayPill}</span></div>
    ${flexRing(fp, totals)}
    <div class="pace-status pace-${fp.tone}">${fp.tone === "good" ? icon("check") : ""}<span>${fp.text}</span>${ctx.isCurrent && fp.capsBudget > 0 ? `<span class="mark-swatch" aria-hidden="true"></span>` : ""}</div>
    <div class="ring-tiles"><div><span><i class="dot dot-spent" aria-hidden="true"></i>Spent</span><strong>${money(fp.capsSpent)}</strong></div><div><span><i class="dot dot-left" aria-hidden="true"></i>${fp.capsSpent > fp.capsBudget + 0.5 ? "Over" : "Remaining"}</span><strong class="${fp.capsSpent > fp.capsBudget + 0.5 ? "bad" : ""}">${money(Math.abs(fp.capsBudget - fp.capsSpent))}</strong></div></div>
  </section>
  ${planCard}
  ${fixedList}
  ${capList}
  <div class="section-title"><h2>Month close</h2><span class="tag ${closed ? "good-tag" : close.ready ? "good-tag" : "warn-tag"}">${closed ? "Closed" : close.ready ? "Ready" : "Review"}</span></div>
  <section class="card close-summary-card"><div><strong>${closed ? `${monthLabel(p.id)} is closed` : "Reconcile, sweep and lock the month"}</strong><div class="sub">${closed ? "Period-linked records are protected until you reopen the month." : close.hardBlockers.length ? `${close.hardBlockers.length} item${close.hardBlockers.length === 1 ? "" : "s"} still need attention.` : "Core close checks are clear."}</div></div><button class="btn ${closed ? "secondary" : ""}" data-action="month-close">${closed ? "View Close Summary" : "Month-End Review"}</button></section>
`;
}

function fixedPaid(actual) {
  return Number(actual || 0) > 0.5;
}
function billDifferenceText(actual, planned) {
  const d = Number(planned || 0) - Number(actual || 0);
  return d > 0.5 ? `${money(d)} under` : d < -0.5 ? `${money(-d)} over` : "";
}
function fixedKpiText(lines) {
  const fixed = lines.filter((x) => x.ruleType === "fixed"),
    toPay = fixed.filter((x) => !fixedPaid(x.actual)).reduce((sum, x) => sum + Number(x.budgetAmount || 0), 0),
    diff = fixed
      .filter((x) => fixedPaid(x.actual))
      .reduce((sum, x) => sum + Number(x.budgetAmount || 0) - Number(x.actual || 0), 0),
    diffText = diff > 0.5 ? ` · ${money(diff)} under` : diff < -0.5 ? ` · ${money(-diff)} over` : "";
  return `${toPay > 0.5 ? `${money(toPay)} still to pay` : "All bills paid"}${diffText}`;
}
function fixedObligationsView(periodId, plan, totals, closed) {
  const lines = plan.lines.filter((x) => x.ruleType === "fixed");
  if (!lines.length) return "";
  const paidCount = lines.filter((x) => fixedPaid(totals[x.id])).length;
  return `<div class="section-title"><h2>Recurring obligations</h2><span class="sub">${paidCount} of ${lines.length} covered</span></div><section class="card obligation-list"><div class="sub" style="padding:0 0 10px">Expected obligations appear every funding month, but Wealth OS creates an expense only when you record the payment.</div>${lines
    .map((x) => {
      const actual = Number(totals[x.id] || 0),
        planned = Number(x.budgetAmount || 0),
        paid = fixedPaid(actual),
        diff = paid ? billDifferenceText(actual, planned) : "";
      return `<div class="obligation-row"><div class="obligation-status ${paid ? "done" : ""}">${paid ? "✓" : "•"}</div><div class="obligation-copy"><strong>${esc(x.name)}</strong><div class="sub">Recurring monthly · ${money(actual)} of ${money(planned)}${paid ? ` · paid${diff ? ` · ${diff}` : ""}` : ""}</div></div>${!paid && !closed ? `<button class="btn ghost small" data-action="record-fixed" data-category="${x.id}" data-amount="${planned}">Record ${money(planned)}</button>` : `<span class="tag ${paid ? "good-tag" : ""}">${paid ? "Paid" : "Not recorded"}</span>`}</div>`;
    })
    .join("")}</section>`;
}

// Flexible spending pace calculations live in pacing.js.
function flexRing(fp, totals) {
  const r = 90,
    C = 2 * Math.PI * r,
    total = Math.max(fp.capsBudget, fp.capsSpent);
  let offset = 0;
  const segs = fp.capLines
    .map((l) => ({ l, spent: Number(totals[l.id] || 0) }))
    .filter((x) => x.spent > 0.5)
    .sort((a, b) => b.spent - a.spent)
    .map(({ l, spent }) => {
      const len = total > 0 ? (spent / total) * C : 0,
        seg = `<circle class="ring-seg t-${categoryVisual(l).tone}" data-arc="${l.id}" cx="110" cy="110" r="${r}" stroke-dasharray="${Math.max(0, len - 1.5).toFixed(1)} ${C.toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}"></circle>`;
      offset += len;
      return seg;
    })
    .join("");
  let mark = "";
  if (fp.ctx.isCurrent && fp.capsBudget > 0 && total > 0) {
    const a = (fp.todaysMark / total) * 2 * Math.PI,
      pt = (rad) => [(110 + rad * Math.sin(a)).toFixed(1), (110 - rad * Math.cos(a)).toFixed(1)];
    const [x1, y1] = pt(74),
      [x2, y2] = pt(106);
    mark = `<line class="ring-mark" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>`;
  }
  const left = fp.capsBudget - fp.capsSpent;
  return `<div class="ring-wrap"><svg viewBox="0 0 220 220" role="img" aria-label="${money(fp.capsSpent)} of ${money(fp.capsBudget)} flexible budget spent${mark ? `; today's mark is ${money(fp.todaysMark)}` : ""}"><circle class="ring-track" cx="110" cy="110" r="${r}"></circle><g transform="rotate(-90 110 110)">${segs}</g>${mark}</svg><div class="ring-center"><strong>${money(Math.abs(left))}</strong><span>${left >= 0 ? "left" : "over"} of ${money(fp.capsBudget)}</span></div></div>`;
}
function budgetKpi(label, value, sub, bad = false) {
  return `<section class="card budget-kpi"><div class="metric-label">${label}</div><div class="kpi-value ${bad ? "bad" : ""}">${value}</div><div class="sub">${sub}</div></section>`;
}

function budgetGroup(group, lines, periodId) {
  const xs = lines.filter((x) => x.group === group);
  if (!xs.length) return "";
  return `<div class="section-title"><h2>${group}</h2></div><section class="card budget-category-list">${xs.map((x) => budgetCategoryRow(x, periodId)).join("")}</section>`;
}
function budgetCategoryRow(x, periodId) {
  let actual = Number(x.actual || 0),
    actualLabel = "Spent";
  if (x.ruleType === "sinking_contribution") {
    actual = completedAllocationToBucket(periodId, x.bucketId);
    actualLabel = "Funded";
  }
  if (x.ruleType === "percentage") {
    actual = completedTithe(periodId);
    actualLabel = "Allocated";
  }
  if (x.ruleType === "buffer") {
    return `<div class="budget-category"><div class="split"><div><strong>${esc(x.name)}</strong><div class="sub">Held for variability and month-end sweep</div></div><div class="budget-numbers"><strong>${money(x.budgetAmount)}</strong><span>planned</span></div></div><div class="progress"><span style="width:0%"></span></div></div>`;
  }
  if (x.ruleType === "fixed") {
    const planned = Number(x.budgetAmount || 0),
      paid = fixedPaid(actual),
      diff = billDifferenceText(actual, planned);
    return `<div class="budget-category"><div class="split"><div><strong>${esc(x.name)}</strong><div class="sub">${paid ? `Paid ${money(actual)}${diff ? ` · ${diff}` : ""}` : "Not paid yet"}</div></div><div class="budget-numbers"><strong>${money(actual)} / ${money(planned)}</strong><span>${paid ? "Paid" : "Due"}</span></div></div><div class="progress"><span style="width:${paid ? 100 : 0}%"></span></div></div>`;
  }
  const budget = x.ruleType === "percentage" ? expectedTithe(periodId) : Number(x.budgetAmount || 0),
    remaining = budget - actual,
    ratio = budget ? Math.max(0, Math.min(1, actual / budget)) : 0;
  return `<div class="budget-category"><div class="split"><div><strong>${esc(x.name)}</strong><div class="sub">${actualLabel} ${money(actual)} · ${remaining >= 0 ? `${money(remaining)} left` : `${money(Math.abs(remaining))} over`}</div></div><div class="budget-numbers"><strong class="${remaining < 0 ? "bad" : ""}">${money(actual)} / ${money(budget)}</strong><span>${pct(ratio)}</span></div></div><div class="progress ${remaining < 0 ? "over" : ""}"><span style="width:${Math.min(100, ratio * 100)}%"></span></div></div>`;
}

function transactionsView() {
  const all = activityRecords();
  const list = filterActivityRecords(all, {
    kind: activityFilter,
    query: activitySearch,
    categories: state.categories,
  });
  const active = state.projects.filter((p) => !p.deletedAt && !projectSettlement(p.id)).length;
  // v1.16: the list comes first, grouped by day with each day's totals. Cash and projects sit in one
  // compact row; the project list only shows here while a project is active.
  return `<div class="activity-quick"><button class="btn secondary small" data-action="cash-withdraw">${icon("cash")}<span>Withdraw cash</span></button><button class="btn secondary small" data-action="open-projects">${icon("project")}<span>Special budgets</span></button></div>
  ${active ? projectOverviewStrip() : ""}
  <div class="section-title"><h2>Recent activity</h2><span class="sub">${list.length} shown</span></div>
  <form id="activity-search-form" class="activity-search"><input id="activity-search-input" type="search" value="${esc(activitySearch)}" placeholder="Search description, category or account"><button class="btn ghost small" type="submit">Search</button>${activitySearch ? '<button class="btn ghost small" type="button" data-action="clear-activity-search">Clear</button>' : ""}</form>
  <div class="filter-chips">${[
    ["all", "All"],
    ["expense", "Expenses"],
    ["income", "Income"],
    ["transfer", "Transfers"],
  ]
    .map(
      ([id, label]) =>
        `<button class="filter-chip ${activityFilter === id ? "active" : ""}" data-action="activity-filter" data-filter="${id}">${label}</button>`,
    )
    .join("")}</div>
  ${list.length ? activityDays(list.slice(0, 150)) : `<section class="card activity-list"><div class="empty compact-empty"><strong>No matching activity.</strong><span>Try another filter or search term.</span></div></section>`}`;
}
function activityDays(list) {
  return groupActivityByDay(list)
    .map(({ key, items, spent, earned }) => {
      const totals = [spent ? `<span>−${money(spent)}</span>` : "", earned ? `<span class="good">+${money(earned)}</span>` : ""]
        .filter(Boolean)
        .join("");
      return `<div class="day-head"><span class="day-name">${esc(dayHeading(key, today()))}</span><span class="day-total">${totals}</span></div><section class="card activity-list">${items.map(txLine).join("")}</section>`;
    })
    .join("");
}

// What can be done with an activity row (shared by the row and its ⋯ menu).
function txActions(x) {
  const protectedIncome = x._kind === "income" && x.systemGenerated === true;
  const plannedTransfer = x._kind === "transfer" && x.status === "planned";
  const canEdit = !protectedIncome && (x._kind !== "transfer" || x.transferType === "manual");
  const canDelete =
    !protectedIncome &&
    (x._kind !== "transfer" ||
      ["bucket_allocation", "cash_withdrawal", "cash_deposit"].includes(x.transferType) ||
      (plannedTransfer && ["manual", "goal_contribution", "supplemental_income_routing"].includes(x.transferType)));
  const canComplete = plannedTransfer;
  const canRoute =
    x._kind === "income" &&
    x.incomeType !== "regular_income" &&
    !x.routingHandled &&
    !routingTransfersForIncome(x.id).length &&
    !isClosedPeriod(x.budgetPeriodId);
  const canRepeat = x._kind === "expense" && !!entryPeriodId();
  return { canEdit, canDelete, canComplete, canRoute, canRepeat };
}
function txLine(x) {
  // Line 1: what it was (and your note). Line 2: where it came from. The day is in the heading above.
  const note = x.description ? String(x.description).trim() : "";
  const fund = x._kind === "expense" && x.fundingBucketId ? bucket(x.fundingBucketId)?.name : "";
  const kindNote =
    x._kind === "transfer" ? (isPurposeOnlyTransfer(x) ? "Virtual only · no bank impact" : "Bank transfer") : "";
  const meta = (x._kind === "transfer" ? [kindNote] : [x._account, fund ? `from ${fund}` : ""]).filter(Boolean).join(" · ");
  const plannedTransfer = x._kind === "transfer" && x.status === "planned";
  const { canEdit, canDelete, canComplete, canRoute, canRepeat } = txActions(x);
  const hasActions = canEdit || canDelete || canComplete || canRoute || canRepeat;
  const amount = money(x._amount);
  return `<div class="tx has-ic" data-entry="${x._kind}:${esc(x.id)}">${catIcon(txVisual(x))}<div class="tx-main"><div class="tx-title">${esc(x._title)}${note && x._kind !== "transfer" ? `<span class="tx-note"> · ${esc(note)}</span>` : ""}</div><div class="tx-meta">${esc(meta)}</div></div><div class="right"><div class="amount ${x._kind === "income" ? "good" : ""}">${x._kind === "transfer" ? "↔ " : ""}${amount}</div>${plannedTransfer ? '<span class="tag warn-tag">planned</span>' : ""}</div>${hasActions ? `<button class="row-menu" type="button" data-action="row-actions" data-kind="${x._kind}" data-id="${x.id}" aria-label="Options for ${esc(x._title)}">⋯</button>` : ""}</div>`;
}

function projectOverviewStrip() {
  const active = state.projects.filter((p) => !p.deletedAt && !projectSettlement(p.id));
  if (!active.length)
    return `<div class="section-title"><h2>Special budgets</h2><span class="sub">Separate from monthly budget</span></div><section class="card project-empty"><div><strong>No active special budget.</strong><div class="sub">Create a Business Trip or another temporary budget.</div></div><button class="btn secondary" data-action="new-project">Create Special Budget</button></section>`;
  return `<div class="section-title"><h2>Special budgets</h2><span class="sub">${active.length} active</span></div><section class="card project-strip">${active
    .slice(0, 3)
    .map((p) => {
      const total = projectKnownTwd(p.id),
        missing = projectMissingTwd(p.id).length;
      return `<button class="project-strip-row" data-action="open-project" data-id="${p.id}"><div><strong>${esc(p.title)}</strong><div class="sub">${money(total)} known${missing ? ` · ${missing} need NTD` : ""}</div></div><span>›</span></button>`;
    })
    .join("")}</section>`;
}
function specialBudgetTypeView() {
  return `<div class="sub">Choose the structure that matches what you are tracking.</div>
  <div class="grid g2" style="margin-top:14px">
    <button class="card choice-card" data-action="new-business-trip" type="button"><strong>Business Trip</strong><span class="sub">Exact reimbursements + fixed daily allowance + deposits + trip pacing.</span></button>
    <button class="card choice-card" data-action="new-custom-budget" type="button"><strong>Custom Budget</strong><span class="sub">Define your own dates, categories, reimbursement rules and optional cap.</span></button>
  </div>`;
}

function projectCategoryRules(p) {
  if (Array.isArray(p?.categoryRules) && p.categoryRules.length) return p.categoryRules;
  if (p?.type === "business_trip") return businessTripCategoryRules();
  return PROJECT_CATEGORIES.map((name) => ({
    id: String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    name,
    treatment: "tracking",
  }));
}

function projectPaymentLabel(method) {
  if (method === "esun_card") return "E.SUN Credit Card";
  if (method === "cash") return "Cash";
  if (method === "ctbc") return "CTBC Operating";
  if (method === "trip_wallet") return "Trip Wallet";
  return "Other";
}

function projectPaymentOptions(selected = "") {
  return [
    ["esun_card", "E.SUN Credit Card"],
    ["cash", "Cash"],
    ["ctbc", "CTBC Operating"],
    ["other", "Other"],
  ]
    .map(([id, label]) => `<option value="${id}" ${selected === id ? "selected" : ""}>${label}</option>`)
    .join("");
}

function projectReimbursementAccountOptions(selected = "") {
  return [
    ["ctbc", "CTBC Operating"],
    ["esun", "E.SUN Reserved"],
    ["cash", "Cash Wallet"],
  ]
    .map(([id, label]) => `<option value="${id}" ${selected === id ? "selected" : ""}>${label}</option>`)
    .join("");
}

function categoryRulesText(p, treatment) {
  return (p?.categoryRules || [])
    .filter((x) => x.treatment === treatment)
    .map((x) => x.name)
    .join("\n");
}

function projectsListView() {
  const items = state.projects
    .filter((p) => !p.deletedAt)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return `<div class="notice"><strong>Special Budgets stay outside your normal monthly budget.</strong><br>Use them for reimbursable trips or temporary spending envelopes. Only final settlement surplus/shortfall enters your personal ledger.</div>
  <div class="actions" style="margin-top:14px"><button class="btn" data-action="new-project">Create Special Budget</button></div>
  <div class="section-title"><h2>Your special budgets</h2><span class="sub">${items.length} total</span></div>
  <section class="card project-list">${
    items.length
      ? items.map((p) => {
          const settlement = projectSettlement(p.id),
            missing = projectMissingTwd(p.id).length,
            summary = projectBudgetSummary(p, projectExpenses(p.id), today()),
            kind = p.type === "business_trip" ? "Business Trip" : p.type === "custom" ? "Custom" : "Legacy";
          const budgetText =
            p.type === "business_trip"
              ? ` · allowance ${money(summary.allowance)}`
              : Number(p.flexibleCapTwd || 0) > 0
                ? ` · cap ${money(p.flexibleCapTwd)}`
                : "";
          return `<button class="project-list-row" data-action="open-project" data-id="${p.id}"><div><div class="split tight"><strong>${esc(p.title)}</strong>${projectStatusTag(p)}</div><div class="sub">${esc(kind)} · ${p.startDate ? esc(p.startDate) : "No start date"}${p.endDate ? ` → ${esc(p.endDate)}` : ""}${budgetText}</div><div class="sub">${money(projectKnownTwd(p.id))} counted spend${missing ? ` · ${missing} missing NTD` : ""}${summary.depositsPending ? ` · ${summary.depositsPending} deposit pending` : ""}${settlement ? ` · reimbursement ${money(settlement.reimbursementTwd)}` : ""}</div></div><span class="project-chevron">›</span></button>`;
        }).join("")
      : `<div class="empty compact-empty"><strong>No special budgets yet.</strong><span>Create a Business Trip or a Custom Budget.</span></div>`
  }</section>`;
}

function projectFormView(p = null, forcedType = null, converting = false) {
  const locked = p && projectSettlement(p.id);
  if (locked)
    return `<div class="notice"><strong>This Special Budget is settled.</strong><br>Undo the settlement before editing it.</div>`;
  const type = forcedType || p?.type || "custom";
  const fundingMode = p?.fundingMode || "reimbursement";
  const wallet = Number(p?.tripWalletAllocatedTwd || 0);
  const id = p?.id || "";
  if (type === "business_trip") {
    return `<form id="project-form" data-type="business_trip" data-convert="${converting ? "true" : "false"}">
      <input type="hidden" name="id" value="${id}">
      <div class="field"><label>Trip name</label><input name="title" value="${esc(p?.title || "")}" required></div>
      <div class="form-grid"><div class="field"><label>Destination</label><input name="destination" value="${esc(p?.destination || "")}" required></div><div class="field"><label>Business purpose</label><input name="purpose" value="${esc(p?.purpose || "")}" required></div></div>
      <div class="form-grid"><div class="field"><label>Departure date</label><input name="startDate" type="date" value="${p?.startDate || today()}" required></div><div class="field"><label>Return date</label><input name="endDate" type="date" value="${p?.endDate || ""}" required></div></div>
      <div class="field"><label>Daily allowance (NTD)</label><input name="dailyAllowanceTwd" type="number" min="0" step="1" value="${p?.dailyAllowanceTwd ?? ""}" required><div class="sub">Departure and return together count as one allowance day. The full allowance is paid regardless of flexible spending.</div></div>
      <div class="form-grid"><div class="field"><label>Default trip currency</label><select name="defaultCurrency"><option value="">Select currency</option>${PROJECT_CURRENCIES.map((cur) => `<option value="${cur}" ${cur === (p?.defaultCurrency || "") ? "selected" : ""}>${cur}</option>`).join("")}</select></div><div class="field"><label>Main payment method</label><select name="mainPaymentMethod"><option value="">Select method</option>${projectPaymentOptions(p?.mainPaymentMethod || "")}</select></div></div>
      <div class="field"><label>Reimbursement received into</label><select name="reimbursementAccountId"><option value="">Select account</option>${projectReimbursementAccountOptions(p?.reimbursementAccountId || "")}</select></div>
      <div class="field"><label>Trip funding</label><select name="fundingMode"><option value="reimbursement" ${fundingMode === "reimbursement" ? "selected" : ""}>Reimbursement only — no Trip Wallet</option><option value="trip_wallet" ${fundingMode === "trip_wallet" ? "selected" : ""}>Reserve operating cash in a Trip Wallet</option></select></div>
      <div class="field"><label>Trip Wallet allocation (NTD)</label><input name="tripWalletAllocatedTwd" type="number" min="0" step="1" value="${wallet || ""}" placeholder="Required only when Trip Wallet is selected"><div class="sub">A Trip Wallet is a virtual reserve from operating cash; it does not create a fake bank transfer.</div></div>
      <div class="notice"><strong>Business Trip categories are automatic.</strong><br>Exact reimbursement: VISA, visa delivery, car rental, hotel, SIM, FX fee, train, Uber, city tax, parking and gas. Flexible allowance: Personal Expenses, Food, Shopping and Others. Refundable deposits are tracked separately.</div>
      ${converting ? '<div class="notice warn"><strong>Existing expenses will be converted, not duplicated.</strong><br>Wealth OS will map the current project rows into Business Trip categories while preserving every original amount, exact NTD amount, payment method and date.</div>' : ""}
      <button class="btn" style="width:100%;margin-top:14px">${converting ? "Convert to Business Trip" : p ? "Save Business Trip" : "Create Business Trip"}</button>
    </form>`;
  }
  return `<form id="project-form" data-type="custom">
    <input type="hidden" name="id" value="${id}">
    <div class="field"><label>Special Budget name</label><input name="title" value="${esc(p?.title || "")}" required></div>
    <div class="form-grid"><div class="field"><label>Start date</label><input name="startDate" type="date" value="${p?.startDate || today()}"></div><div class="field"><label>End date (optional)</label><input name="endDate" type="date" value="${p?.endDate || ""}"></div></div>
    <div class="form-grid"><div class="field"><label>Default currency</label><select name="defaultCurrency">${PROJECT_CURRENCIES.map((cur) => `<option value="${cur}" ${cur === (p?.defaultCurrency || "EUR") ? "selected" : ""}>${cur}</option>`).join("")}</select></div><div class="field"><label>Shared flexible cap (NTD, optional)</label><input name="flexibleCapTwd" type="number" min="0" step="1" value="${p?.flexibleCapTwd ?? ""}"></div></div>
    <div class="field"><label>Exact-reimbursement categories</label><textarea name="exactCategories" rows="3" placeholder="One category per line">${esc(categoryRulesText(p, "exact"))}</textarea></div>
    <div class="field"><label>Flexible / capped categories</label><textarea name="flexibleCategories" rows="3" placeholder="One category per line">${esc(categoryRulesText(p, "flexible"))}</textarea></div>
    <div class="field"><label>Tracking-only categories</label><textarea name="trackingCategories" rows="3" placeholder="One category per line">${esc(categoryRulesText(p, "tracking") || (!p?.categoryRules ? PROJECT_CATEGORIES.join("\n") : ""))}</textarea></div>
    <div class="field"><label>Funding</label><select name="fundingMode"><option value="reimbursement" ${fundingMode === "reimbursement" ? "selected" : ""}>No Trip Wallet / reserve</option><option value="trip_wallet" ${fundingMode === "trip_wallet" ? "selected" : ""}>Reserve operating cash in a wallet</option></select></div>
    <div class="field"><label>Wallet allocation (NTD)</label><input name="tripWalletAllocatedTwd" type="number" min="0" step="1" value="${wallet || ""}"></div>
    <button class="btn" style="width:100%;margin-top:14px">${p ? "Save Special Budget" : "Create Special Budget"}</button>
  </form>`;
}

function projectExpenseFormView(projectId, x = null) {
  const p = project(projectId);
  if (!p) return '<div class="empty">Special Budget not found.</div>';
  if (projectSettlement(projectId))
    return '<div class="notice"><strong>Special Budget settled.</strong><br>Undo the settlement before adding or editing entries.</div>';
  const cur = x?.currency || p.defaultCurrency || "EUR";
  const rules = projectCategoryRules(p);
  const selectedCategoryId = x?.categoryId || rules.find((r) => r.name === x?.category)?.id || rules[0]?.id || "other";
  const recordType = x?.recordType || "expense";
  return `<form id="project-expense-form" data-project="${p.id}">
    <input type="hidden" name="id" value="${x?.id || ""}">
    <div class="notice"><strong>${esc(p.title)}</strong><br>This entry remains isolated from your normal monthly budget until settlement.</div>
    ${p.type === "business_trip" ? `<div class="field" style="margin-top:14px"><label>Entry type</label><select name="recordType"><option value="expense" ${recordType === "expense" ? "selected" : ""}>Expense</option><option value="refundable_deposit" ${recordType === "refundable_deposit" ? "selected" : ""}>Refundable deposit / card hold</option></select><div class="sub">Deposits do not count as spending unless some amount is ultimately retained.</div></div>` : '<input type="hidden" name="recordType" value="expense">'}
    <div class="form-grid" style="margin-top:14px"><div class="field"><label>Original amount</label><input name="originalAmount" type="number" min="0" step="0.01" value="${x?.originalAmount ?? ""}" required></div><div class="field"><label>Currency</label><select name="currency">${PROJECT_CURRENCIES.map((cur2) => `<option value="${cur2}" ${cur2 === cur ? "selected" : ""}>${cur2}</option>`).join("")}</select></div></div>
    <div class="field"><label>Exact NTD amount</label><input name="twdAmount" type="number" min="0" step="1" value="${x?.twdAmount ?? ""}" placeholder="Exact amount shown in your card/bank app"><div class="sub">This exact NTD value is used for reimbursement and trip totals. If the entry itself is TWD, Wealth OS uses the original amount when this is blank.</div></div>
    <div class="form-grid"><div class="field"><label>Category</label><select name="categoryId">${rules.map((rule) => `<option value="${rule.id}" ${rule.id === selectedCategoryId ? "selected" : ""}>${esc(rule.name)} · ${rule.treatment === "exact" ? "Exact" : rule.treatment === "flexible" ? "Flexible" : "Tracking"}</option>`).join("")}</select></div><div class="field"><label>Payment method</label><select name="paymentMethod">${projectPaymentOptions(x?.paymentMethod || p.mainPaymentMethod || "esun_card")}</select></div></div>
    <div class="field"><label>Date</label><input name="date" type="date" value="${x?.date || today()}" required></div>
    <div class="field"><label>Description (optional)</label><input name="description" value="${esc(x?.description || "")}"></div>
    <button class="btn" style="width:100%">${x ? "Save Changes" : "Add Entry"}</button>
  </form>`;
}

function depositStatusLabel(x) {
  if (!isRefundableDeposit(x)) return "";
  if (!depositResolved(x)) return "Pending refund";
  if (x.depositStatus === "refunded") return "Refunded";
  if (x.depositStatus === "partial") return `Partially retained · ${money(x.retainedTwd || 0)}`;
  return `Not refunded · ${money(x.retainedTwd || 0)} retained`;
}

function projectExpenseLine(x, p) {
  const isDeposit = isRefundableDeposit(x);
  const twd = Number(x.twdAmount) > 0 ? money(x.twdAmount) : '<span class="warn">NTD pending</span>';
  const rule = categoryRuleFor(p, x);
  const treatment = x.reimbursementType || rule?.treatment || "tracking";
  const treatmentLabel = treatment === "exact" ? "Exact reimbursement" : treatment === "flexible" ? "Flexible allowance" : "Tracking";
  return `<div class="project-expense-line"><div><strong>${esc(x.category || rule?.name || "Other")}</strong> <span class="tag">${esc(isDeposit ? "Deposit" : treatmentLabel)}</span><div class="sub">${esc(dayLabel(x.date))} · ${esc(projectPaymentLabel(x.paymentMethod))}${x.description ? ` · ${esc(x.description)}` : ""}</div><div class="sub">${esc(formatOriginal(x.originalAmount, x.currency))} · ${twd}${isDeposit ? ` · ${esc(depositStatusLabel(x))}` : ""}</div></div><div class="project-line-actions">${isDeposit && !projectSettlement(x.projectId) ? `<button class="text-btn" data-action="resolve-project-deposit" data-project="${x.projectId}" data-id="${x.id}">Resolve</button>` : ""}<button class="text-btn" data-action="edit-project-expense" data-project="${x.projectId}" data-id="${x.id}">Edit</button><button class="text-btn danger-text" data-action="delete-project-expense" data-project="${x.projectId}" data-id="${x.id}">Delete</button></div></div>`;
}

function projectTrackerRow(item, denominator, mode) {
  const amount = Number(item.amount || 0),
    ratio = denominator > 0 ? Math.max(0, Math.min(1, amount / denominator)) : 0,
    countText = `${item.count} entr${item.count === 1 ? "y" : "ies"}`;
  if (mode === "exact") {
    return `<div class="budget-category special-budget-category"><div class="split"><div><strong>${esc(item.name)}</strong><div class="sub">${countText} · reimbursed at actual amount</div></div><div class="budget-numbers"><strong>${money(amount)}</strong><span>${denominator > 0 ? `${pct(ratio)} of exact total` : "No spend yet"}</span></div></div><div class="progress"><span style="width:${Math.min(100, ratio * 100)}%"></span></div></div>`;
  }
  return `<div class="budget-category special-budget-category"><div class="split"><div><strong>${esc(item.name)}</strong><div class="sub">${countText} · shared allowance</div></div><div class="budget-numbers"><strong>${money(amount)}</strong><span>${denominator > 0 ? `${pct(ratio)} of allowance` : "No allowance"}</span></div></div><div class="progress"><span style="width:${Math.min(100, ratio * 100)}%"></span></div></div>`;
}

function projectExactTrackerBlock(p, expenses, summary) {
  if (p.type !== "business_trip") return "";
  const rows = projectCategoryBreakdown(p, expenses, "exact").filter((x) => x.amount > 0 || x.count > 0);
  return `<div class="section-title"><h2>Exact reimbursement</h2><span class="sub">${money(summary.exact)} expected back</span></div>
  <section class="card special-budget-tracker">
    <div class="special-budget-tracker-head"><div><div class="metric-label">Exact reimbursable spent</div><div class="metric">${money(summary.exact)}</div><div class="sub">Company reimbursement follows the exact NTD amount recorded for each expense.</div></div><div class="budget-numbers"><strong>${money(summary.exact)}</strong><span>expected exact reimbursement</span></div></div>
    ${rows.length ? `<div class="special-budget-category-list">${rows.map((x) => projectTrackerRow(x, summary.exact, "exact")).join("")}</div><div class="sub special-budget-bar-note">Category bars show each category's share of exact reimbursable spending; they are not spending limits.</div>` : '<div class="empty compact-empty"><strong>No exact-reimbursement spending yet.</strong></div>'}
  </section>`;
}

function projectFlexibleTrackerBlock(p, expenses, summary) {
  if (p.type !== "business_trip") return "";
  const rows = projectCategoryBreakdown(p, expenses, "flexible"),
    usedPct = summary.allowance > 0 ? Math.max(0, (summary.flexible / summary.allowance) * 100) : 0,
    timePct = summary.totalAllowanceDays > 0 ? Math.max(0, Math.min(100, (summary.elapsedAllowanceDays / summary.totalAllowanceDays) * 100)) : 0,
    avgDaily = summary.elapsedAllowanceDays > 0 ? summary.flexible / summary.elapsedAllowanceDays : 0,
    remainingText = summary.flexible <= summary.allowance
      ? `${money(summary.remainingAllowance)} left`
      : `${money(summary.flexible - summary.allowance)} over`;
  return `<div class="section-title"><h2>Flexible allowance</h2><span class="tag ${summary.paceKey === "good" ? "good-tag" : summary.paceKey === "bad" ? "warn-tag" : ""}">${esc(summary.paceLabel)}</span></div>
  <section class="card special-budget-tracker">
    <div class="special-budget-tracker-head"><div><div class="metric-label">Shared trip allowance</div><div class="metric ${summary.flexible > summary.allowance ? "bad" : ""}">${remainingText}</div><div class="sub">${money(summary.flexible)} spent of ${money(summary.allowance)}</div></div><div class="budget-numbers"><strong class="${summary.flexible > summary.allowance ? "bad" : ""}">${usedPct.toFixed(0)}%</strong><span>allowance used</span></div></div>
    <div class="special-budget-progress" aria-label="${usedPct.toFixed(0)} percent of flexible allowance used; ${timePct.toFixed(0)} percent of trip allowance time elapsed"><div class="progress ${summary.flexible > summary.allowance ? "over" : ""}"><span style="width:${Math.min(100, usedPct).toFixed(1)}%"></span></div><span class="special-budget-time-mark" style="left:${timePct.toFixed(1)}%" aria-hidden="true"></span></div>
    <div class="sub special-budget-pace-caption">${usedPct.toFixed(0)}% allowance used · ${timePct.toFixed(0)}% trip time elapsed · ${summary.elapsedAllowanceDays.toFixed(1)} of ${summary.totalAllowanceDays} allowance days</div>
    <div class="special-budget-category-list">${rows.map((x) => projectTrackerRow(x, summary.allowance, "flexible")).join("")}</div>
    <div class="grid g2 special-budget-stats"><div><span class="metric-label">Average flexible spend</span><strong>${money(avgDaily)}/day</strong></div><div><span class="metric-label">Safe remaining pace</span><strong>${money(summary.safeDaily)}/day</strong></div><div><span class="metric-label">Projected flexible spend</span><strong>${money(summary.projectedFlexible)}</strong></div><div><span class="metric-label">Expected trip result</span><strong class="${summary.expectedResult >= 0 ? "good" : "bad"}">${summary.expectedResult >= 0 ? "+" : "−"}${money(Math.abs(summary.expectedResult))}</strong></div></div>
  </section>`;
}

function projectDetailView(projectId) {
  const p = project(projectId);
  if (!p) return '<div class="empty">Special Budget not found.</div>';
  const expenses = projectExpenses(projectId),
    settlement = projectSettlement(projectId),
    known = projectKnownTwd(projectId),
    missing = projectMissingTwd(projectId),
    original = projectOriginalTotals(projectId),
    card = projectPaymentTwd(projectId, "esun_card"),
    summary = projectBudgetSummary(p, expenses, today()),
    pendingDeposits = unresolvedDeposits(expenses);
  const originalText =
    Object.entries(original).map(([cur, v]) => formatOriginal(v, cur)).join(" · ") || "No counted expenses yet";
  const kind = p.type === "business_trip" ? "Business Trip" : p.type === "custom" ? "Custom Budget" : "Legacy Special Project";
  const metadata = p.type === "business_trip"
    ? `${esc(p.destination || "")}${p.purpose ? ` · ${esc(p.purpose)}` : ""}<br>${p.startDate ? esc(dayLabel(p.startDate)) : ""}${p.endDate ? ` → ${esc(dayLabel(p.endDate))}` : ""} · ${allowanceDays(p.startDate, p.endDate)} allowance days · ${money(totalFlexibleAllowance(p))}`
    : `${p.startDate ? esc(dayLabel(p.startDate)) : ""}${p.endDate ? ` → ${esc(dayLabel(p.endDate))}` : ""} · default ${esc(p.defaultCurrency || "EUR")}`;

  let settlementBlock = "";
  if (settlement) {
    const diff = Number(settlement.differenceTwd || 0);
    settlementBlock = `<div class="section-title"><h2>Settlement</h2><span class="tag good-tag">Settled</span></div><section class="card settlement-card">${p.type === "business_trip" ? row("Expected reimbursement", money(settlement.expectedReimbursementTwd ?? summary.expectedReimbursement)) : ""}${row("Counted project cost", money(settlement.totalProjectCostTwd))}${row("Reimbursement received", money(settlement.reimbursementTwd))}${row(diff >= 0 ? "Surplus" : "Personal responsibility", `${diff >= 0 ? "+" : "−"}${money(Math.abs(diff))}`)}${row("E.SUN card spend", money(settlement.cardPaidTwd || 0))}<div class="notice" style="margin-top:12px">Card-clearing guidance: fund E.SUN for the card-paid project amount as needed before the card debit is due. Wealth OS keeps that clearing movement outside personal spending to avoid double counting.</div>${Number(settlement.cardPaidTwd || 0) > 0 && !settlement.cardClearingConfirmed ? `<button class="btn secondary" style="width:100%;margin-top:12px" data-action="confirm-project-card-clearing" data-id="${p.id}">Mark ${money(settlement.cardPaidTwd)} card funding done</button>` : Number(settlement.cardPaidTwd || 0) > 0 ? '<div class="good-notice notice" style="margin-top:12px">E.SUN card funding marked complete.</div>' : ""}<div class="actions" style="margin-top:12px"><button class="btn ghost" data-action="export-project-csv" data-id="${p.id}">Export CSV</button><button class="btn ghost danger-text" data-action="undo-project-settlement" data-id="${p.id}">Undo Settlement</button></div></section>`;
  } else {
    const blocked = missing.length || pendingDeposits.length;
    settlementBlock = `<div class="section-title"><h2>Reimbursement</h2><span class="sub">Settle when company payment arrives</span></div><section class="card"><div class="project-settlement-layout"><div class="project-settlement-copy"><strong>${blocked ? "Resolve items before settlement" : "Ready for settlement"}</strong><div class="sub">${p.type === "business_trip" ? `Expected reimbursement ${money(summary.expectedReimbursement)} · exact ${money(summary.exact)} + allowance ${money(summary.allowance)}` : `Known project cost ${money(known)}`} · E.SUN card ${money(card)}</div></div><button class="btn project-settlement-cta" data-action="settle-project" data-id="${p.id}" ${!expenses.length || blocked ? "disabled" : ""}>Settle Reimbursement</button></div>${missing.length ? `<div class="sub warn" style="margin-top:8px">${missing.length} expense${missing.length === 1 ? " needs" : "s need"} an exact NTD amount.</div>` : ""}${pendingDeposits.length ? `<div class="sub warn" style="margin-top:8px">${pendingDeposits.length} refundable deposit${pendingDeposits.length === 1 ? " is" : "s are"} still pending. Resolve the refund status first.</div>` : ""}</section>`;
  }

  const walletBlock = p.fundingMode === "trip_wallet"
    ? `<div class="section-title"><h2>Trip Wallet</h2><span class="sub">Virtual reserve from operating cash</span></div><section class="card">${row("Allocated", money(summary.walletAllocated))}${row("Counted spend", money(summary.totalSpend))}${row("Budget balance", money(summary.walletRemaining))}${summary.walletOverspend > 0 ? `<div class="notice warn" style="margin-top:10px">Over the Trip Wallet allocation by ${money(summary.walletOverspend)}.</div>` : ""}</section>`
    : "";

  const legacyConvert = !p.type && !settlement
    ? '<div class="notice" style="margin-top:14px"><strong>Legacy Special Project</strong><br>You can keep using it as-is or convert it to the Business Trip format without duplicating the existing expenses.<div class="actions" style="margin-top:10px"><button class="btn secondary" data-action="convert-project-business" data-id="' + p.id + '">Convert to Business Trip</button></div></div>'
    : "";

  const nonTripSummary = p.type === "business_trip"
    ? ""
    : `<div class="grid g2 project-summary-grid" style="margin-top:14px"><section class="card nested-card"><div class="metric-label">Counted NTD spend</div><div class="metric">${money(known)}</div><div class="sub">${missing.length ? `${missing.length} NTD conversion${missing.length === 1 ? "" : "s"} pending` : "All counted expenses valued"}</div></section><section class="card nested-card"><div class="metric-label">Original currency totals</div><strong>${esc(originalText)}</strong><div class="sub">Preserved exactly as entered</div></section></div>`;

  return `<div class="split"><div><h3 class="project-title">${esc(p.title)}</h3><div class="sub">${esc(kind)}</div><div class="sub">${metadata}</div></div>${projectStatusTag(p)}</div>
    ${legacyConvert}
    ${nonTripSummary}
    ${projectExactTrackerBlock(p, expenses, summary)}
    ${projectFlexibleTrackerBlock(p, expenses, summary)}
    ${walletBlock}
    ${summary.depositsPending ? `<div class="section-title"><h2>Refundable deposits</h2><span class="tag warn-tag">${summary.depositsPending} pending</span></div><section class="card"><strong>${money(summary.depositsPendingTwd)} currently held</strong><div class="sub">Excluded from spending and expected reimbursement until the refund outcome is resolved.</div></section>` : ""}
    <div class="actions project-top-actions" style="margin-top:14px">${!settlement ? `<button class="btn" data-action="add-project-expense" data-project="${p.id}">Add Entry</button><button class="btn secondary" data-action="edit-project" data-id="${p.id}">Edit Budget</button>` : ""}<button class="btn ghost" data-action="export-project-csv" data-id="${p.id}">Export CSV</button></div>
    ${settlementBlock}
    <div class="section-title"><h2>Activity</h2><span class="sub">${expenses.length} recorded</span></div><section class="card project-expense-list">${expenses.length ? expenses.map((x) => projectExpenseLine(x, p)).join("") : '<div class="empty compact-empty"><strong>No activity yet.</strong><span>Add expenses or refundable deposits here.</span></div>'}</section>`;
}

function projectDepositResolveView(projectId, expenseId) {
  const p = project(projectId),
    x = state.projectExpenses.find((e) => e.id === expenseId && !e.deletedAt);
  if (!p || !x || !isRefundableDeposit(x)) return '<div class="empty">Deposit not found.</div>';
  const rules = projectCategoryRules(p);
  const selected = x.categoryId || "car_rental";
  return `<form id="project-deposit-form" data-project="${projectId}" data-id="${expenseId}">
    <div class="notice"><strong>${esc(x.description || x.category || "Refundable deposit")}</strong><br>Original hold: ${esc(formatOriginal(x.originalAmount, x.currency))} · ${Number(x.twdAmount) > 0 ? money(x.twdAmount) : "NTD pending"}.</div>
    <div class="field" style="margin-top:14px"><label>Refund outcome</label><select name="depositStatus"><option value="pending" ${!depositResolved(x) ? "selected" : ""}>Still pending</option><option value="refunded" ${x.depositStatus === "refunded" ? "selected" : ""}>Fully refunded / authorization released</option><option value="partial" ${x.depositStatus === "partial" ? "selected" : ""}>Partially refunded</option><option value="retained" ${x.depositStatus === "retained" ? "selected" : ""}>Not refunded</option></select></div>
    <div class="field"><label>Amount retained (NTD)</label><input name="retainedTwd" type="number" min="0" step="1" value="${x.retainedTwd ?? ""}" placeholder="Required for partial or not refunded"></div>
    <div class="field"><label>If money was retained, classify it as</label><select name="categoryId">${rules.map((rule) => `<option value="${rule.id}" ${rule.id === selected ? "selected" : ""}>${esc(rule.name)} · ${rule.treatment === "exact" ? "Exact" : rule.treatment === "flexible" ? "Flexible" : "Tracking"}</option>`).join("")}</select></div>
    <button class="btn" style="width:100%">Save Deposit Status</button>
  </form>`;
}

function projectSettlementFormView(projectId) {
  const p = project(projectId);
  if (!p) return '<div class="empty">Special Budget not found.</div>';
  if (projectSettlement(projectId)) return '<div class="notice">This Special Budget is already settled.</div>';
  const expenses = projectExpenses(projectId),
    missing = projectMissingTwd(projectId),
    pending = unresolvedDeposits(expenses),
    total = projectKnownTwd(projectId),
    card = projectPaymentTwd(projectId, "esun_card"),
    summary = projectBudgetSummary(p, expenses, today());
  if (pending.length)
    return `<div class="notice"><strong>Settlement blocked.</strong><br>${pending.length} refundable deposit${pending.length === 1 ? " is" : "s are"} unresolved. Confirm whether each hold was refunded first.</div>`;
  if (missing.length)
    return `<div class="notice"><strong>Settlement blocked.</strong><br>${missing.length} expense${missing.length === 1 ? " still needs" : "s still need"} an exact NTD amount.</div>`;
  const expected = p.type === "business_trip" ? Math.round(summary.expectedReimbursement) : "";
  return `<form id="project-settlement-form" data-project="${p.id}">
    <div class="notice"><strong>Net-settlement accounting</strong><br>Enter the actual company reimbursement received. Wealth OS posts only the final surplus or personal shortfall to your personal ledger.</div>
    <section class="card" style="margin-top:14px">${p.type === "business_trip" ? row("Exact reimbursable", money(summary.exact)) + row("Fixed allowance", money(summary.allowance)) + row("Expected reimbursement", money(summary.expectedReimbursement)) : ""}${row("Counted project cost", money(total))}${row("E.SUN card-paid subtotal", money(card))}${row("Cash / other subtotal", money(Math.max(0, total - card)))}</section>
    <div class="form-grid" style="margin-top:14px"><div class="field"><label>Actual reimbursement received (NTD)</label><input id="project-reimbursement" name="reimbursementTwd" type="number" min="0" step="1" value="${expected}" required></div><div class="field"><label>Date received</label><input name="date" type="date" value="${today()}" required></div></div>
    <div id="project-settlement-preview" class="notice">Enter the reimbursement amount to calculate the final result.</div>
    <div class="field" style="margin-top:14px"><label>If there is a surplus</label><select name="surplusRoute"><option value="keep">Keep in reimbursement account</option><option value="emergency">Emergency Fund</option><option value="home-trip">Home Travel Fund</option><option value="equipment">Equipment Fund</option><option value="invest">Investments</option></select></div>
    <button class="btn" style="width:100%;margin-top:14px">Confirm Settlement</button>
  </form>`;
}

function goalsView() {
  const emergency = goal("goal-emergency"),
    travel = goal("goal-home-trip");
  const emergencyBal = emergency ? goalBal(emergency) : 0,
    travelBal = travel ? goalBal(travel) : 0;
  const active = activeGoal(state.goals, state.bucketBalances),
    pace = currentPaceMonthly();
  const strategyForecast = scenarioFor(
    Number(state.settings.forecastInvestmentReturn || 7),
    Number(state.settings.forecastSalaryGrowth || 3),
    0,
    forecastBaselineSalary(),
  );
  const cards = [...state.goals]
    .filter((g) => g.status !== "archived")
    .sort((a, b) => a.priority - b.priority)
    .map((g) => {
      const b = goalBal(g),
        target = Number(g.targetAmount || 0),
        p = target ? Math.min(1, b / target) : 0,
        remaining = Math.max(0, target - b),
        status = goalStatus(g);
      let rule = "Manual goal";
      if (g.id === "goal-emergency") rule = "Primary core-wealth goal";
      if (g.id === "goal-home-trip")
        rule = `Unlocks at ${money(g.prerequisiteAmount || 0)} Emergency Fund · then ${money(g.monthlyTarget || 0)}/month`;
      if (g.id === "goal-equipment") rule = "Paused unless you deliberately activate it";
      let paceText = goalPaceText(g);
      if (g.id === "goal-home-trip" && status.key === "waiting")
        paceText = `Expected unlock: ${dateAfterMonths(strategyForecast.sim.events.travelUnlockMonth)}`;
      return `<section class="card goal-card"><div class="split"><div><strong>${esc(g.name)}</strong><div class="sub">${esc(rule)}</div></div><span class="tag ${status.className}">${status.label}</span></div><div class="goal-metric-row"><div><div class="metric">${privateMoney(b)}</div><div class="sub">${privateMoney(remaining)} remaining</div></div><div class="right"><strong>${pct(p)}</strong><div class="sub">of ${privateMoney(target)}</div></div></div><div class="progress"><span data-bar="goal-${g.id}" style="width:${p * 100}%"></span></div><div class="goal-pace">${esc(paceText)}</div>${g.targetDate ? `<div class="sub">Target date: ${esc(dayLabel(g.targetDate))}</div>` : ""}<div class="actions goal-actions"><button class="btn secondary" data-action="goal-contribution" data-id="${g.id}">Add Contribution</button><button class="btn ghost" data-action="edit-goal" data-id="${g.id}">Edit Goal</button></div></section>`;
    })
    .join("");
  return `<div class="sub page-sub">Your wealth priorities, pace and planned-use funds.</div>
  <section class="card strategy-card" style="margin-top:14px"><div class="split"><div><div class="metric-label">Current routing strategy</div><strong>${esc(active?.name || "Core cash goals complete")}</strong></div><div class="right"><strong>${privateMoney(pace)}</strong><div class="sub">recent monthly core-wealth pace</div></div></div><div class="strategy-steps"><span class="${emergencyBal < 200000 ? "active-step" : ""}">1. Emergency to ${money(200000)}</span><span class="${emergencyBal >= 200000 && travelBal < (travel?.targetAmount || 100000) ? "active-step" : ""}">2. Home Travel ${money(travel?.monthlyTarget || 10000)}/mo + continue Emergency</span><span class="${emergencyBal >= (emergency?.targetAmount || 300000) ? "active-step" : ""}">3. After Emergency target, remaining surplus becomes investable</span></div></section>
  <div class="grid g2 goals-grid" style="margin-top:14px">${cards}</div>`;
}

function wealthView() {
  const fx = state.settings.usdTwdRate;
  const ct = accountSnapshot("ctbc"),
    specialBudgetReserve = activeSpecialBudgetReserve(),
    operatingAvailable = Number(ct.actual || 0) - specialBudgetReserve;
  const es = esunSnapshot();
  const cash = accountSnapshot("cash");
  const ctStatus = !ct.verified ? "Not checked" : Math.abs(ct.difference) < 0.5 ? "Reconciled" : "Ledger mismatch";
  const ctStatusClass = !ct.verified ? "" : Math.abs(ct.difference) < 0.5 ? " good-tag" : " warn-tag";
  const cashStatus = cash.actual < -0.5 ? "Negative balance" : cash.verified ? "Counted" : "Tracked";
  const cashStatusClass = cash.actual < -0.5 ? " warn-tag" : cash.verified ? " good-tag" : "";
  let esStatus = "Not checked";
  let esStatusClass = "";
  if (es.verified) {
    if (es.bankOk && es.allocationOk) {
      esStatus = "Fully reconciled";
      esStatusClass = " good-tag";
    } else if (!es.bankOk && !es.allocationOk) {
      esStatus = "2 items to resolve";
      esStatusClass = " warn-tag";
    } else if (!es.bankOk) {
      esStatus = "Ledger mismatch";
      esStatusClass = " warn-tag";
    } else {
      esStatus = "Allocation needed";
      esStatusClass = " warn-tag";
    }
  }
  const allocationText = es.allocationOk
    ? "Complete"
    : es.unassigned > 0
      ? `${money(es.unassigned)} unassigned`
      : `${money(Math.abs(es.unassigned))} over-allocated`;
  return `<div class="privacy-all-money"><div class="sub page-sub">Physical accounts and virtual purpose ledgers</div>
  <div class="grid g2" style="margin-top:14px"><section class="card"><div class="metric-label">Core Wealth</div><div class="metric">${money(state.wealth.coreWealth)}</div><div class="sub">Long-term capital only</div></section><section class="card"><div class="metric-label">Financial Net Worth</div><div class="metric">${money(state.wealth.financialNetWorth)}</div><div class="sub">Tithe excluded · includes cash on hand</div></section></div>

  <div class="section-title"><h2>Account health</h2><span class="sub">Match Wealth OS to real money</span></div>
  <section class="card account-health">
    ${accountHealthRow("CTBC Operating", ct.actual, ctStatus, ctStatusClass)}
    ${accountHealthRow("Cash Wallet", cash.actual, cashStatus, cashStatusClass)}
    ${accountHealthRow("E.SUN Reserved", es.actual, esStatus, esStatusClass)}
    ${accountHealthRow("IBKR", latestInvestmentTwd(), "Portfolio value", "")}
  </section>

  <div class="section-title"><h2>CTBC Operating</h2><span class="tag${ctStatusClass}">${ctStatus}</span></div>
  <section class="card account-detail-card">
    <div class="account-balance-head"><div><div class="metric-label">Tracked current balance</div><div class="metric">${money(ct.actual)}</div>${ct.verified ? `<div class="sub">Last checked ${esc(ct.reconciliation.date || "")}${ct.isEstimated ? " · updated by recorded activity" : ""}</div>` : `<div class="sub">Using ledger balance until you confirm it</div>`}</div></div>
    <div class="reconcile-grid two-col"><div><span class="sub">Ledger expected</span><strong>${money(ct.expected)}</strong></div><div><span class="sub">Bank vs ledger</span><strong class="${Math.abs(ct.difference) < 0.5 ? "good" : ct.difference < 0 ? "bad" : "warn"}">${ct.difference > 0 ? "+" : ""}${money(ct.difference)}</strong></div></div>
    ${specialBudgetReserve > 0 ? `<div class="row"><div><strong>Special Budget reserve</strong><div class="sub">Virtual Trip Wallet money reserved from operating cash</div></div><strong class="amount">${money(specialBudgetReserve)}</strong></div><div class="row"><div><strong>Available operating cash</strong><div class="sub">Tracked CTBC balance minus active Special Budget reserves</div></div><strong class="amount">${money(operatingAvailable)}</strong></div>` : ""}
    <div class="row"><div><strong>Electricity Reserve</strong><div class="sub">Virtual reserve held inside CTBC · no bank transfer required</div></div><strong class="amount">${money(state.bucketBalances.electricity || 0)}</strong></div>
    ${accountActions(`<button class="btn secondary" data-action="account-reconcile" data-id="ctbc">Update Balance</button>`, "ctbc")}
  </section>

  <div class="section-title"><h2>Cash Wallet</h2><span class="tag${cashStatusClass}">${cashStatus}</span></div>
  <section class="card account-detail-card cash-card">
    <div class="account-balance-head"><div><div class="metric-label">Cash on hand</div><div class="metric">${money(cash.actual)}</div>${cash.verified ? `<div class="sub">Last counted ${esc(cash.reconciliation.date || "")}${cash.isEstimated ? " · updated by recorded activity" : ""}</div>` : `<div class="sub">Starts at zero and changes only through CTBC cash transfers and cash expenses</div>`}</div></div>
    <div class="notice" style="margin-top:14px">ATM withdrawals are <strong>transfers</strong>, not expenses. Only spending from Cash Wallet counts as an expense.</div>
    ${accountActions(`<button class="btn" data-action="cash-withdraw">Withdraw Cash</button>`, "cash")}
  </section>

  <div class="section-title"><h2>E.SUN Reserved</h2><span class="tag${esStatusClass}">${esStatus}</span></div>
  <section class="card esun-card">
    <div class="account-balance-head"><div><div class="metric-label">Tracked current balance</div><div class="metric">${money(es.actual)}</div>${es.verified ? `<div class="sub">Last checked ${esc(es.reconciliation.date || "")}${es.isEstimated ? " · updated by recorded activity" : ""}</div>` : `<div class="sub">Using ledger balance until you confirm it</div>`}</div></div>
    <div class="reconcile-grid"><div><span class="sub">Ledger expected</span><strong>${money(es.expected)}</strong></div><div><span class="sub">Virtual allocated</span><strong>${money(es.virtualTotal)}</strong></div><div><span class="sub">Bank reconciliation</span><strong class="${es.bankOk ? "good" : es.difference < 0 ? "bad" : "warn"}">${es.bankOk ? "Matched" : `${es.difference > 0 ? "+" : ""}${money(es.difference)}`}</strong></div><div><span class="sub">Purpose allocation</span><strong class="${es.allocationOk ? "good" : "warn"}">${allocationText}</strong></div></div>
    ${!es.allocationOk ? `<div class="allocation-callout"><div><strong>${es.unassigned > 0 ? `${money(es.unassigned)} needs a purpose` : `Allocations exceed the bank balance by ${money(Math.abs(es.unassigned))}`}</strong><div class="sub">Assign or reduce virtual buckets explicitly. Wealth OS will never guess.</div></div><button class="btn" data-action="esun-allocate">${es.unassigned > 0 ? "Assign Money" : "Reduce Allocation"}</button></div>` : ""}
    ${accountActions(`<button class="btn secondary" data-action="account-reconcile" data-id="esun">Update Balance</button>`, "esun")}
  </section>
  <div class="section-title"><h2>E.SUN virtual composition</h2><span class="sub">Purpose ledger</span></div><section class="card">${state.buckets
    .filter((b) => b.accountId === "esun")
    .map((b) => row(b.name, money(state.bucketBalances[b.id] || 0)))
    .join(
      "",
    )}<div class="row"><strong>Virtual total</strong><strong class="amount">${money(es.virtualTotal)}</strong></div>${!es.allocationOk ? `<div class="row"><strong>${es.unassigned > 0 ? "Unassigned" : "Over-allocated"}</strong><strong class="amount ${es.unassigned < 0 ? "bad" : "warn"}">${es.unassigned > 0 ? "+" : ""}${money(es.unassigned)}</strong></div>` : ""}</section>
  <div class="section-title"><h2>Investments</h2></div><section class="card">${row("IBKR current value", money(latestInvestmentTwd()))}${row("USD/TWD rate", Number(fx).toFixed(2))}<div class="actions" style="margin-top:12px"><button class="btn secondary" data-action="investment-snapshot">Update IBKR Value</button></div></section></div>`;
}

function accountHealthRow(name, value, status, statusClass = "") {
  return `<div class="account-health-row"><div><strong>${esc(name)}</strong><div class="sub">${money(value)}</div></div><span class="tag${statusClass}">${esc(status)}</span></div>`;
}

function spendingPaceFor(periodId, line) {
  return spendingPaceForRows(periodId, line, state.expenses);
}
function spendingPaceSvg(periodId, line, pace) {
  if (pace.days <= 0 || pace.budget <= 0) return "";
  const w = 320,
    h = 92,
    pad = 8,
    maxY = Math.max(pace.budget, pace.projected, pace.spent, 1) * 1.08;
  const x = (d) => pad + (Math.max(0, d) / pace.days) * (w - pad * 2),
    y = (v) => h - pad - (Math.max(0, v) / maxY) * (h - pad * 2);
  const daily = new Map();
  for (const e of pace.expenses) {
    const d = Number(String(e.date || "").slice(8, 10));
    if (d >= 1 && d <= pace.days) daily.set(d, (daily.get(d) || 0) + Number(e.amount || 0));
  }
  let cum = 0;
  const pts = [[0, 0]];
  for (let d = 1; d <= pace.elapsed; d++) {
    cum += daily.get(d) || 0;
    pts.push([d, cum]);
  }
  const actual = pts.map(([d, v], i) => `${i ? "L" : "M"} ${x(d).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const projectionEnd = Math.min(maxY, pace.projected);
  return `<svg class="pace-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(line.name)} spending pace"><line class="pace-grid" x1="${pad}" y1="${y(pace.budget)}" x2="${w - pad}" y2="${y(pace.budget)}"/><path class="pace-target" d="M ${x(0)} ${y(0)} L ${x(pace.days)} ${y(pace.budget)}"/><path class="pace-actual" d="${actual}"/>${pace.elapsed > 0 && pace.elapsed < pace.days ? `<path class="pace-projection" d="M ${x(pace.elapsed)} ${y(pace.spent)} L ${x(pace.days)} ${y(projectionEnd)}"/>` : ""}<circle class="pace-dot" cx="${x(pace.elapsed)}" cy="${y(pace.spent)}" r="3.5"/></svg>`;
}
function spendingPaceInsights() {
  const p = currentPeriod();
  if (!p)
    return `<div class="notice"><strong>No active funding month.</strong><br>Create a funding month to see spending pace.</div>`;
  const plan = planFor(p.id),
    caps = plan.lines.filter((x) => x.ruleType === "cap" && Number(x.budgetAmount || 0) > 0),
    ctx = monthPaceContext(p.id);
  if (!caps.length)
    return `<div class="notice"><strong>No flexible caps found.</strong><br>Add capped categories in Settings to use spending pace.</div>`;
  const cards = caps
    .map((line) => {
      const pace = spendingPaceFor(p.id, line),
        used = pace.budget ? pace.spent / pace.budget : 0,
        elapsed = pace.days ? pace.elapsed / pace.days : 0,
        tag =
          pace.status.key === "good"
            ? "good-tag"
            : pace.status.key === "bad"
              ? "bad-tag"
              : pace.status.key === "warn"
                ? "warn-tag"
                : "";
      return `<section class="card pace-card"><div class="split"><div><strong>${esc(line.name)}</strong><div class="sub">${money(pace.spent)} of ${money(pace.budget)} · ${pct(used)} used</div></div><span class="tag ${tag}">${pace.status.label}</span></div>${spendingPaceSvg(p.id, line, pace)}<div class="pace-bars"><div><div class="split tiny"><span>Budget used</span><span>${pct(used)}</span></div><div class="progress"><span data-bar="pace-${line.id}" style="width:${Math.min(100, used * 100)}%"></span></div></div><div><div class="split tiny"><span>Month elapsed</span><span>${pct(elapsed)}</span></div><div class="progress muted-progress"><span data-bar="elapsed-${line.id}" style="width:${Math.min(100, elapsed * 100)}%"></span></div></div></div><div class="grid g3 pace-metrics"><div><span>Expected by now</span><strong>${money(pace.expected)}</strong></div><div><span>Projected month-end</span><strong class="${pace.projected > pace.budget ? "bad" : ""}">${money(pace.projected)}</strong></div><div><span>Safe daily from now</span><strong>${pace.remaining > 0 ? money(pace.safeDaily) : "—"}</strong></div></div><div class="pace-note">${pace.status.detail} · ${pace.remaining} day${pace.remaining === 1 ? "" : "s"} remaining · ${pace.confidence} forecast confidence.</div></section>`;
    })
    .join("");
  return `<div class="pace-summary"><div><strong>${monthLabel(p.id)} spending pace</strong><div class="sub">Day ${ctx.elapsed} of ${ctx.days}. Target pace assumes each capped budget is spread evenly across the month.</div></div></div><div class="pace-grid-cards">${cards}</div><div class="notice compact-notice">Daily pace is most useful for frequent spending such as Food and Transportation. Irregular categories such as Gas or Water can naturally look uneven during the month.</div>`;
}

function forecastView() {
  const records = historyRecords(),
    recent = records.slice(-6),
    current = records.at(-1) || null,
    previous = records.length > 1 ? records.at(-2) : null;
  const year = today().slice(0, 4),
    annual = yearSummary(year),
    recent3 = records.slice(-3),
    avgRate = recent3.length ? recent3.reduce((s, x) => s + x.contributionRate, 0) / recent3.length : 0;
  const salary = Number(current?.regularIncome || forecastBaselineSalary() || 0);
  const base = scenarioFor(
    Number(state.settings.forecastInvestmentReturn || 7),
    Number(state.settings.forecastSalaryGrowth || 3),
    0,
    salary,
  );
  const conservative = scenarioFor(
    Number(state.settings.conservativeInvestmentReturn || 4),
    Number(state.settings.conservativeSalaryGrowth || 1),
    0,
    salary,
  );
  const aggressive = scenarioFor(
    Number(state.settings.aggressiveInvestmentReturn || 9),
    Number(state.settings.aggressiveSalaryGrowth || 5),
    0,
    salary,
  );
  const currentRate = current?.contributionRate || 0;
  const netWorthRecords = records.filter((x) => x.financialNetWorth !== null),
    coreRecords = records.filter((x) => x.coreWealth !== null);
  const compare =
    previous && current
      ? `<section class="card comparison-card">
    ${comparisonLine("Income", current.totalIncome, previous.totalIncome, false, false, true)}
    ${comparisonLine("Spending", current.expenses, previous.expenses, true)}
    ${comparisonLine("Core wealth contributed", current.wealthContribution, previous.wealthContribution, false, false, true)}
    ${comparisonLine("Contribution rate", current.contributionRate, previous.contributionRate, false, true)}
  </section>`
      : `<div class="notice"><strong>Monthly comparison needs one more funding month.</strong><br>Once two months exist, Wealth OS will show what changed in income, spending and wealth contributions.</div>`;
  const flexCats = state.categories.filter((c) => c.ruleType === "cap");
  const catRows = flexCats
    .map((c) => {
      const samples = recent3.map((r) => Number(r.actuals?.[c.id] || 0));
      const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
      const cur = Number(current?.actuals?.[c.id] || 0),
        budget = Number(
          (planFor(current?.id || currentPeriod()?.id)?.lines?.find((x) => x.id === c.id)?.budgetAmount ??
            c.defaultAmount) ||
            0,
        );
      return { c, avg, cur, budget };
    })
    .sort((a, b) => b.avg - a.avg);
  const catHistory =
    records.length < 2
      ? `<div class="notice"><strong>Category trends are still building.</strong><br>After another month, 3-month averages and recurring over/under-budget patterns will appear here.</div>`
      : `<section class="card insight-list">${catRows.map((x) => `<div class="insight-row"><div><strong>${esc(x.c.name)}</strong><div class="sub">Current ${money(x.cur)} · ${Math.min(3, recent3.length)}-mo avg ${money(x.avg)}</div></div><div class="right"><strong class="${x.avg > x.budget ? "bad" : x.avg < x.budget * 0.8 ? "good" : ""}">${money(x.budget)}</strong><div class="sub">monthly cap</div></div></div>`).join("")}</section>`;
  return `<div class="sub page-sub">See whether this month's spending is on pace, then use history and forecasts for longer-term planning.</div>
  <div class="section-title"><h2>Spending pace</h2><span class="sub">Flexible caps vs days elapsed</span></div>
  ${spendingPaceInsights()}
  <div class="section-title"><h2>Wealth & history</h2><span class="sub">Contribution and month-to-month trends</span></div>
  <div class="grid g3 summary-grid">
    <section class="card"><div class="metric-label">Current contribution rate</div><div class="metric">${pct(currentRate)}</div><div class="sub">Core wealth ÷ regular take-home</div></section>
    <section class="card"><div class="metric-label">Recent average</div><div class="metric">${pct(avgRate)}</div><div class="sub">${recent3.length}-month contribution rate</div></section>
    <section class="card"><div class="metric-label">${year} wealth contributed</div><div class="metric">${privateMoney(annual.wealth)}</div><div class="sub">Recorded core-wealth contributions</div></section>
  </div>

  <div class="section-title"><h2>Monthly comparison</h2><span class="sub">Latest vs previous funding month</span></div>${compare}

  <div class="section-title"><h2>Contribution history</h2><span class="sub">Completed core-wealth transfers</span></div>
  <section class="card privacy-all-money">${recent.length ? contributionBars(recent) : '<div class="empty compact-empty"><strong>No funding-month history yet.</strong></div>'}</section>

  <div class="section-title"><h2>Core wealth trend</h2><span class="sub">Month-end snapshots + current month</span></div>
  <section class="card privacy-all-money">${coreRecords.length >= 2 ? trendSvg(coreRecords, "coreWealth") : `<div class="empty compact-empty"><strong>Not enough snapshots yet.</strong><span>Close another month to build a meaningful wealth trend.</span></div>`}</section>

  <div class="section-title"><h2>Flexible spending trends</h2><span class="sub">Recent behavior vs your caps</span></div>${catHistory}

  <div class="section-title"><h2>${year} recorded summary</h2><span class="sub">Only data entered in Wealth OS</span></div>
  <div class="grid g2 annual-grid">
    ${insightKpi("Income", annual.income, "All recorded income", true)}
    ${insightKpi("Expenses", annual.expenses, "Actual spending")}
    ${insightKpi("Tithe contributed", annual.tithe, "Net Tithe additions · purpose reallocations excluded", true)}
    ${insightKpi("Emergency added", annual.emergency, "Completed Emergency contributions", true)}
    ${insightKpi("Invested", annual.investments, "Transfers into IBKR", true)}
    ${insightKpi("Net-worth change", annual.netWorthChange === null ? "—" : signedMoney(annual.netWorthChange), annual.netWorthChange === null ? "Need 2 recorded snapshots" : "From first to latest recorded snapshot", true)}
  </div>

  <div class="section-title"><h2>Forecast assumptions</h2><span class="sub">What the base forecast is actually using</span></div>
  <section class="card forecast-assumptions">
    ${row("Take-home salary baseline", privateMoney(salary))}
    ${row("Current Emergency Fund", privateMoney(state.bucketBalances.emergency || 0))}
    ${row("Starting monthly wealth capacity", privateMoney(base.monthly))}
    ${row("Home Travel unlock threshold", money(goal("goal-home-trip")?.prerequisiteAmount || 200000))}
    ${row("Emergency Fund target", money(goal("goal-emergency")?.targetAmount || 300000))}
    ${row("Home Travel monthly routing after unlock", money(goal("goal-home-trip")?.monthlyTarget || 10000))}
    ${row("Current investments", privateMoney(latestInvestmentTwd()))}
    ${row("Raise captured to wealth", `${Number(state.settings.wealthRaisePercent || 75)}%`)}
    <div class="sub" style="margin-top:10px">Emergency cash earns 0% in the model. Investment-return assumptions apply only to IBKR. When Home Travel unlocks, its monthly target temporarily reduces what flows to the Emergency Fund.</div>
  </section>

  <div class="section-title"><h2>Planning scenarios</h2><span class="sub">Salary growth and investment return modeled separately</span></div>
  <div class="grid g3 scenario-grid">
    ${scenarioCard("Conservative", conservative)}
    ${scenarioCard("Base", base, true)}
    ${scenarioCard("Aggressive", aggressive)}
  </div>
  <div class="section-title"><h2>Base milestones</h2><span class="sub">${base.returnPct}% return · ${base.growthPct}% annual salary growth</span></div>
  <section class="card forecast-events">${row(`Home Travel unlock · Emergency ${money(goal("goal-home-trip")?.prerequisiteAmount || 200000)}`, formatMonths(base.sim.events.travelUnlockMonth))}${row(`Emergency Fund complete · ${money(goal("goal-emergency")?.targetAmount || 300000)}`, formatMonths(base.sim.events.emergencyCompleteMonth))}${row("Home Travel funded", formatMonths(base.sim.events.travelCompleteMonth))}${base.targets.map((t) => row(money(t), formatMonths(base.sim.hits[t]))).join("")}</section>

  <div class="section-title"><h2>Long-range checkpoints</h2><span class="sub">Base scenario; return applies only to investments</span></div>
  <div class="grid g2 forecast-checkpoints privacy-all-money">${base.sim.snapshots.map((x) => `<section class="card"><div class="metric-label">Year ${x.month / 12}</div><div class="metric">${money(x.coreWealth)}</div><div class="sub">Emergency ${money(x.emergency)} · Investments ${money(x.investment)}</div><div class="sub">Modeled salary ${money(x.salary)}</div></section>`).join("")}</div>

  <div class="section-title"><h2>Scenario lab</h2></div><section class="card"><div class="notice">Test take-home salary, annual salary growth, investment return, or an extra monthly wealth contribution. This never changes your real budget.</div><div class="form-grid" style="margin-top:12px"><div class="field"><label>Take-home salary</label><input id="scenario-salary" type="number" value="${Math.round(salary)}"></div><div class="field"><label>Annual salary growth (%)</label><input id="scenario-growth" type="number" step="0.1" value="${Number(state.settings.forecastSalaryGrowth || 3)}"></div><div class="field"><label>Annual investment return (%)</label><input id="scenario-return" type="number" step="0.1" value="${Number(state.settings.forecastInvestmentReturn || 7)}"></div><div class="field"><label>Extra monthly wealth contribution</label><input id="scenario-extra" type="number" step="1" value="0"></div></div><button class="btn" data-action="run-scenario">Run Scenario</button><div id="scenario-result" style="margin-top:12px"></div></section>`;
}
function insightKpi(label, value, sub, sensitive = false) {
  const shown = typeof value === "number" ? money(value) : value;
  return `<section class="card insight-kpi"><div class="metric-label">${esc(label)}</div><div class="kpi-value">${sensitive ? privateValue(shown) : shown}</div><div class="sub">${esc(sub)}</div></section>`;
}
function comparisonLine(label, current, previous, lowerIsBetter = false, isPercent = false, sensitive = false) {
  const delta = Number(current || 0) - Number(previous || 0),
    good = lowerIsBetter ? delta < 0 : delta > 0,
    bad = lowerIsBetter ? delta > 0 : delta < 0;
  const value = isPercent ? pct(current) : money(current),
    deltaText = isPercent ? `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)} pp` : signedMoney(delta);
  const prevValue = isPercent ? pct(previous) : money(previous);
  const shownValue = sensitive ? privateValue(value) : value,
    shownPrev = sensitive ? privateValue(prevValue) : prevValue,
    shownDelta = sensitive ? privateValue(deltaText) : deltaText;
  return `<div class="comparison-line"><div><strong>${esc(label)}</strong><div class="sub">Previous ${shownPrev}</div></div><div class="right"><strong>${shownValue}</strong><div class="sub ${good ? "good" : bad ? "bad" : ""}">${shownDelta}</div></div></div>`;
}
function scenarioCard(label, s, featured = false) {
  return `<section class="card scenario-card ${featured ? "featured" : ""}"><div class="split"><strong>${esc(label)}</strong>${featured ? '<span class="tag good-tag">Base</span>' : ""}</div><div class="scenario-assumptions">${s.returnPct}% investment return · ${s.growthPct}% salary growth</div><div class="scenario-milestone"><span>Emergency complete</span><strong>${formatMonths(s.sim.events.emergencyCompleteMonth)}</strong></div><div class="scenario-milestone"><span>${money(1000000)}</span><strong>${formatMonths(s.sim.hits[1000000])}</strong></div><div class="scenario-milestone"><span>${money(5000000)}</span><strong>${formatMonths(s.sim.hits[5000000])}</strong></div></section>`;
}

function renderModal() {
  if (modal.type === "paycheck") return modalWrap("New Paycheck", paycheckForm());
  if (modal.type === "expense")
    return modalWrap(
      modal.id ? "Edit Expense" : "Add Expense",
      expenseForm(
        modal.id ? state.expenses.find((x) => x.id === modal.id) : null,
        modal.prefill || null,
        modal.periodId || null,
      ),
    );
  if (modal.type === "income")
    return modalWrap(
      modal.id ? "Edit Income" : "Add Income",
      incomeForm(modal.id ? state.incomes.find((x) => x.id === modal.id) : null),
    );
  if (modal.type === "new-entry") {
    const kind = modal.kind || "expense";
    const kinds = `<div class="theme-switch entry-kind" role="group" aria-label="Entry type">${[
      ["expense", "Expense"],
      ["income", "Income"],
      ["transfer", "Transfer"],
    ]
      .map(
        ([k, label]) =>
          `<button type="button" class="theme-option ${kind === k ? "active" : ""}" data-action="entry-kind" data-kind="${k}" aria-pressed="${kind === k}">${label}</button>`,
      )
      .join("")}</div>`;
    const body =
      kind === "income"
        ? incomeForm(null)
        : kind === "transfer"
          ? manualTransferForm(null)
          : expenseForm(null, null, modal.periodId || entryPeriodId());
    const extra = `<div class="entry-extras"><button type="button" class="text-btn" data-action="cash-withdraw">Withdraw cash</button><button type="button" class="text-btn" data-action="open-projects">Special budgets</button></div>`;
    return modalWrap("New entry", kinds + body + extra);
  }
  if (modal.type === "income-routing") return modalWrap("Route Supplemental Income", incomeRoutingView(modal.incomeId));
  if (modal.type === "manual-transfer") {
    const x = modal.draft
      ? {
          id: modal.draft.id || "",
          amount: modal.draft.amount,
          fromAccountId: modal.draft.from,
          toAccountId: modal.draft.to,
          budgetPeriodId: modal.draft.periodId,
          status: modal.draft.status,
          plannedDate: modal.draft.date,
          completedDate: modal.draft.status === "completed" ? modal.draft.date : null,
          _bucketId: modal.draft.bucketId,
        }
      : modal.id
        ? state.transfers.find((x) => x.id === modal.id)
        : null;
    return modalWrap(modal.id ? "Edit Transfer" : "Record Transfer", manualTransferForm(x));
  }
  if (modal.type === "transfer") return modalWrap("Confirm Transfer", transferConfirm(modal.id));
  if (modal.type === "payday-transfer")
    return modalWrap("Confirm Payday Transfer", paydayTransferConfirm(modal.periodId, modal.accountId));
  if (modal.type === "close") return modalWrap("Month-End Review", monthCloseView());
  if (modal.type === "settings") return modalWrap("Settings", settingsView());
  if (modal.type === "manage-categories") return modalWrap("Budget Categories", manageCategoriesView());
  if (modal.type === "category-form")
    return modalWrap(modal.id ? "Edit Category" : "Add Category", categoryForm(modal.id ? category(modal.id) : null));
  if (modal.type === "manage-funds") return modalWrap("Savings Funds", manageFundsView());
  if (modal.type === "fund-form") return modalWrap(modal.id ? "Edit Fund" : "Add Fund", fundForm(modal.id ? bucket(modal.id) : null));
  if (modal.type === "data-health") return modalWrap("Data Health", dataHealthView());
  if (modal.type === "investment") return modalWrap("Update IBKR Value", investmentForm());
  if (modal.type === "account-reconcile")
    return modalWrap(
      `Update ${physicalAccount(modal.accountId)?.name || "Account"} Balance`,
      accountReconciliationForm(modal.accountId),
    );
  if (modal.type === "reconcile-preview") return modalWrap("Review Balance Update", reconciliationPreviewView());
  if (modal.type === "account-audit")
    return modalWrap(
      `${physicalAccount(modal.accountId)?.name || "Account"} Audit Trail`,
      accountAuditView(modal.accountId),
    );
  if (modal.type === "account-adjustment")
    return modalWrap(
      `Add ${physicalAccount(modal.accountId)?.name || "Account"} Adjustment`,
      accountAdjustmentForm(modal.accountId),
    );
  if (modal.type === "esun-allocate") return modalWrap("Assign E.SUN Money", esunAllocationForm());
  if (modal.type === "esun-reallocate") return modalWrap("Reallocate E.SUN Purpose", esunReallocationForm());
  if (modal.type === "manual-transfer-review") return modalWrap("Review Bank Transfer", manualTransferReview());
  if (modal.type === "cash-transfer")
    return modalWrap(
      modal.mode === "deposit" ? "Deposit Cash" : "Withdraw Cash",
      cashTransferForm(modal.mode || "withdrawal"),
    );
  if (modal.type === "projects-list") return modalWrap("Special Budgets", projectsListView());
  if (modal.type === "project-type") return modalWrap("Create Special Budget", specialBudgetTypeView());
  if (modal.type === "project-form")
    return modalWrap(
      modal.id ? "Edit Special Budget" : modal.budgetType === "business_trip" ? "Create Business Trip" : "Create Custom Budget",
      projectFormView(modal.id ? project(modal.id) : null, modal.budgetType || null, false),
    );
  if (modal.type === "project-convert-business")
    return modalWrap("Convert to Business Trip", projectFormView(project(modal.id), "business_trip", true));
  if (modal.type === "project-detail")
    return modalWrap(project(modal.id)?.title || "Special Budget", projectDetailView(modal.id));
  if (modal.type === "project-expense")
    return modalWrap(
      modal.expenseId ? "Edit Special Budget Entry" : "Add Special Budget Entry",
      projectExpenseFormView(
        modal.projectId,
        modal.expenseId ? state.projectExpenses.find((x) => x.id === modal.expenseId && !x.deletedAt) : null,
      ),
    );
  if (modal.type === "project-deposit")
    return modalWrap("Resolve Refundable Deposit", projectDepositResolveView(modal.projectId, modal.expenseId));
  if (modal.type === "project-settle")
    return modalWrap("Settle Reimbursement", projectSettlementFormView(modal.projectId));
  if (modal.type === "row-actions") {
    const x = activityRecords().find((r) => r._kind === modal.kind && r.id === modal.id);
    return modalWrap(esc(x?._title || "Entry"), rowActionsView(modal.kind, modal.id));
  }
  if (modal.type === "delete-period") return modalWrap("Delete Funding Month", deleteFundingMonthView(modal.periodId));
  if (modal.type === "account-actions")
    return modalWrap(esc(physicalAccount(modal.accountId)?.name || "Account"), accountActionsView(modal.accountId));
  if (modal.type === "month-actions") return modalWrap(monthLabel(modal.periodId), monthActionsView(modal.periodId));
  if (modal.type === "month-summary")
    return modalWrap(`${monthLabel(modal.periodId)} closed`, monthSummaryView(modal.periodId, modal.emergencyFrom));
  if (modal.type === "edit-goal") return modalWrap("Edit Goal", goalEditForm(modal.goalId));
  if (modal.type === "goal-contribution") return modalWrap("Add Goal Contribution", goalContributionForm(modal.goalId));
  return "";
}
// v1.17: each account card keeps its main button; the rest live behind "More".
const ACCOUNT_MORE = {
  ctbc: [
    ["account-audit", "Audit Trail"],
    ["account-adjustment", "Add Adjustment"],
  ],
  cash: [
    ["cash-deposit", "Deposit Cash"],
    ["account-reconcile", "Count Cash"],
    ["account-audit", "Audit Trail"],
  ],
  esun: [
    ["account-audit", "Audit Trail"],
    ["esun-reallocate", "Reallocate Purpose"],
    ["account-adjustment", "Add Adjustment"],
  ],
};
function accountActions(primary, accountId) {
  const name = physicalAccount(accountId)?.name || "this account";
  return `<div class="account-actions account-actions-two">${primary}<button class="btn ghost account-more" data-action="account-actions" data-id="${accountId}" aria-label="More for ${esc(name)}">More</button></div>`;
}
function accountActionsView(accountId) {
  return `<div class="action-sheet">${(ACCOUNT_MORE[accountId] || [])
    .map(([action, label]) => `<button class="btn secondary" data-action="${action}" data-id="${accountId}">${label}</button>`)
    .join("")}</div>`;
}
// The month picker's ⋯ on Budget: review, reopen, or (for a mistaken month) delete.
function monthActionsView(periodId) {
  const p = state.periods.find((x) => x.id === periodId);
  if (!p) return `<div class="empty compact-empty"><strong>This month no longer exists.</strong></div>`;
  const closed = p.state === "closed";
  return `<div class="action-sheet"><button class="btn secondary" data-action="month-close">Month-End Review</button>${
    closed ? `<button class="btn secondary" data-action="reopen-period" data-id="${p.id}">Reopen ${monthLabel(p.id)}</button>` : ""
  }${
    closed
      ? ""
      : `<div class="action-sheet-danger"><button class="btn ghost danger-text" data-action="delete-period" data-id="${p.id}">Delete ${monthLabel(p.id)}…</button><div class="sub" style="margin-top:6px">For a test or mistaken funding month. You'll see what it removes first.</div></div>`
  }</div>`;
}
// Shown once, right after a month is closed: what the month added up to. Reads only; saves nothing.
function monthSummaryView(periodId, emergencyFrom) {
  const close = state.monthlyCloses.find((x) => x.id === periodId || x.budgetPeriodId === periodId);
  const plan = close?.planSnapshot || planFor(periodId),
    totals = close?.categoryActuals || expenseTotals(periodId);
  const spent = Number(close?.expenses ?? totalExpenses(periodId)),
    planned = plan.lines
      .filter((l) => ["fixed", "cap"].includes(l.ruleType))
      .reduce((n, l) => n + Number(l.budgetAmount || 0), 0);
  const toWealth = Number(close?.wealthContribution ?? completedCoreWealth(periodId)),
    swept = Number(close?.sweepAmount || 0);
  const fixed = plan.lines.filter((l) => l.ruleType === "fixed"),
    paid = fixed.filter((l) => fixedPaid(totals[l.id])).length;
  const caps = plan.lines
    .filter((l) => l.ruleType === "cap" && Number(l.budgetAmount || 0) > 0)
    .map((l) => ({ l, diff: Number(l.budgetAmount || 0) - Number(totals[l.id] || 0) }))
    .sort((a, b) => a.diff - b.diff);
  const over = caps.filter((x) => x.diff < -0.5).length,
    under = caps.filter((x) => x.diff > 0.5).length;
  // Every cap that went over, then the three biggest savings; the rest are summed up in one line.
  const shown = [...caps.filter((x) => x.diff < -0.5), ...caps.filter((x) => x.diff >= -0.5).sort((a, b) => b.diff - a.diff).slice(0, 3)],
    hidden = caps.length - shown.length;
  const capRows = shown
    .map(
      ({ l, diff }) =>
        `<div class="ms-cap">${catIcon(categoryVisual(l), "sm")}<span>${esc(l.name)}</span><strong class="${diff < -0.5 ? "bad" : diff > 0.5 ? "good" : ""}">${Math.abs(diff) < 0.5 ? "On budget" : `${money(Math.abs(diff))} ${diff < 0 ? "over" : "under"}`}</strong></div>`,
    )
    .join("") + (hidden > 0 ? `<div class="ms-cap-more">+ ${hidden} more cap${hidden === 1 ? "" : "s"} on or under budget</div>` : "");
  const em = goal("goal-emergency"),
    target = Number(em?.targetAmount || 0),
    now = em ? goalBal(em) : 0,
    from = Number.isFinite(Number(emergencyFrom)) ? Number(emergencyFrom) : now,
    pctOf = (v) => (target > 0 ? Math.min(100, (v / target) * 100) : 0);
  const emergency = em
    ? `<div class="ms-goal"><div class="hero-goal-row"><strong>${esc(em.name || "Emergency Fund")}</strong><span>${privateMoney(now)} of ${money(target)}</span></div><div class="ms-bar"><span data-bar="ms-emergency" data-from="${pctOf(from).toFixed(1)}%" style="width:${pctOf(now).toFixed(1)}%"></span></div><div class="sub">${now - from > 0.5 ? `+${privateMoney(now - from)} this month · ` : ""}${pct(target ? now / target : 0)}${target && now >= target ? " · goal reached" : ""}</div></div>`
    : "";
  return `<div class="month-summary">
    <div class="ms-hero"><span class="ms-check" aria-hidden="true">${icon("check")}</span><div><strong>${privateMoney(toWealth)} to wealth</strong><span>${swept > 0.5 ? `including ${privateMoney(swept)} swept at month end` : "No month-end sweep this month"}</span></div></div>
    <div class="ms-tiles"><div><span>Spent</span><strong>${money(spent)}</strong><small>of ${money(planned)} planned</small></div><div><span>Bills paid</span><strong>${paid} of ${fixed.length}</strong><small>${paid === fixed.length ? "All covered" : `${fixed.length - paid} not recorded`}</small></div><div><span>Caps</span><strong>${under} under</strong><small>${over ? `${over} over` : "None over"}</small></div></div>
    ${capRows ? `<div class="ms-caps">${capRows}</div>` : ""}
    ${emergency}
    <button class="btn" data-action="close-modal" style="width:100%;margin-top:4px">Done</button>
  </div>`;
}
function rowActionsView(kind, id) {
  const x = activityRecords().find((r) => r._kind === kind && r.id === id);
  if (!x) return `<div class="empty compact-empty"><strong>This entry no longer exists.</strong></div>`;
  const { canEdit, canDelete, canComplete, canRoute, canRepeat } = txActions(x);
  const btn = (action, label, extra = "") =>
    `<button class="btn ${action === "delete-transaction" ? "ghost danger-text" : "secondary"}" data-action="${action}" data-id="${x.id}" ${extra}>${label}</button>`;
  return `<div class="sub" style="margin-bottom:12px">${esc([dayLabel(x._date), money(Math.abs(x._amount)), x._account].filter(Boolean).join(" · "))}</div><div class="action-sheet">${[
    canComplete && btn("complete-transfer", "Complete transfer"),
    canRoute && btn("route-income", "Route income"),
    canRepeat && btn("repeat-expense", "Repeat expense"),
    canEdit && btn("edit-transaction", "Edit", `data-kind="${kind}"`),
  ]
    .filter(Boolean)
    .join("")}${canDelete ? `<div class="action-sheet-danger">${btn("delete-transaction", `Delete ${kind}`, `data-kind="${kind}"`)}</div>` : ""}</div>`;
}
function modalWrap(title, body) {
  return `<div class="modal-backdrop" data-action="backdrop-close"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(String(title).replace(/<[^>]*>/g, ""))}" onclick="event.stopPropagation()"><div class="split"><h3>${title}</h3><button class="btn ghost small" data-action="close-modal">Close</button></div>${body}</section></div>`;
}
function paycheckForm() {
  const d = today(),
    // The next paycheck funds the month after your latest funding month (even if it lands a few
    // days late); the very first paycheck funds the month after it was received.
    latest = [...state.periods].map((x) => x.id).sort().at(-1),
    mid = latest ? nextMonthId(`${latest}-15`) : nextMonthId(d);
  return `<form id="paycheck-form"><div class="field"><label>Exact take-home salary</label><input name="amount" type="number" min="0" step="1" required placeholder="Amount that landed in your account"></div><div class="form-grid"><div class="field"><label>Date received</label><input name="date" type="date" value="${d}" required></div><div class="field"><label>Funding month</label><input name="period" type="month" value="${mid}" required></div></div><div class="notice">The paycheck date and funding month are separate. A salary received at month-end can fund the following month.</div><button class="btn" style="margin-top:14px;width:100%">Calculate & Create Funding Plan</button></form>`;
}
function expenseForm(x = null, prefill = null, targetPeriodId = null) {
  const periodId = x?.budgetPeriodId || targetPeriodId || entryPeriodId();
  if (!periodId) return `<div class="empty">Create an open funding month first.</div>`;
  if (isClosedPeriod(periodId))
    return `<div class="notice"><strong>${monthLabel(periodId)} is closed.</strong><br>Reopen the month before adding or editing expenses.</div>`;
  const catId = x?.categoryId || prefill?.categoryId || "food",
    accountId = x?.accountId || prefill?.accountId || "ctbc",
    bucketId = x?.fundingBucketId || prefill?.fundingBucketId || "";
  const amount = x?.amount ?? prefill?.amount ?? "",
    description = x?.description ?? prefill?.description ?? "";
  // Flexible caps first (the everyday ones), then fixed bills, then reserve-funded expenses.
  const groupRank = { cap: 0, fixed: 1, expense_only: 2 };
  const cats = state.categories
    .filter((c) => ["fixed", "cap", "expense_only"].includes(c.ruleType) && !c.hiddenFromManualEntry && (c.active !== false || c.id === catId))
    .sort((a, b) => groupRank[a.ruleType] - groupRank[b.ruleType] || (a.sort || 0) - (b.sort || 0));
  const selected = cats.some((c) => c.id === catId) ? catId : cats[0]?.id;
  const plan = planFor(periodId),
    totals = expenseTotals(periodId);
  const hintFor = (c) => {
    const line = plan.lines.find((l) => l.id === c.id),
      spent = Number(totals[c.id] || 0);
    if (c.ruleType === "cap" && line) {
      const left = Number(line.budgetAmount || 0) - spent;
      return left >= 0 ? `${money(left)} left this month` : `${money(-left)} over this month`;
    }
    if (c.ruleType === "fixed" && line)
      return fixedPaid(spent) ? `Paid ${money(spent)} this month` : `${money(line.budgetAmount)} expected this month`;
    const fund = c.defaultFundingBucketId ? bucket(c.defaultFundingBucketId) : null;
    return fund ? `Paid from ${fund.name}` : "";
  };
  const activeProjects = state.projects.filter((p) => !p.deletedAt && !projectSettlement(p.id));
  const projectTile = x
    ? ""
    : `<button type="button" class="cat-tile cat-tile-extra" ${activeProjects.length === 1 ? `data-action="add-project-expense" data-project="${activeProjects[0].id}"` : 'data-action="open-projects"'}>${catIcon({ icon: "project", tone: "slate" }, "sm")}<span class="cat-name">Project</span></button>`;
  const selectedCat = cats.find((c) => c.id === selected);
  return `<form id="expense-form" class="entry-form"><input type="hidden" name="id" value="${x?.id || ""}"><input type="hidden" name="periodId" value="${periodId}"><label class="amount-field"><span class="amount-label">Amount</span><span class="amount-input"><span class="amount-cur">NT$</span><input name="amount" type="number" inputmode="numeric" min="0" step="1" value="${amount}" required placeholder="0"></span></label><div class="cat-head"><span class="cat-head-label" id="cat-head-label">Category</span><span class="cat-hint" id="cat-hint" aria-live="polite">${esc(selectedCat ? hintFor(selectedCat) : "")}</span></div><div class="cat-grid" role="radiogroup" aria-labelledby="cat-head-label">${cats
    .map((c) => {
      const name = SHORT_CATEGORY_NAMES[c.name] || c.name;
      return `<label class="cat-tile${c.id === selected ? " selected" : ""}" title="${esc(c.name)}"><input type="radio" name="category" value="${c.id}" ${c.id === selected ? "checked" : ""} data-hint="${esc(hintFor(c))}">${catIcon(categoryVisual(c), "sm")}<span class="cat-name">${esc(name)}</span></label>`;
    })
    .join("")}${projectTile}</div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${x?.date || today()}" required></div><div class="field"><label>Account used</label><select name="account">${state.accounts
    .filter((a) => a.role !== "investment")
    .map((a) => `<option value="${a.id}" ${a.id === accountId ? "selected" : ""}>${esc(a.name)}</option>`)
    .join(
      "",
    )}</select></div></div><div class="field"><label>Note (optional)</label><input name="description" value="${esc(description)}" placeholder="Lunch, laundry, electricity..."></div><details class="entry-more"${bucketId ? " open" : ""}><summary>Pay from a savings bucket</summary><div class="field"><label>Funding bucket</label><select name="fundingBucket"><option value="">Operating cash</option>${state.buckets
    .filter((b) => b.bucketType !== "restricted" && (b.active !== false || b.id === bucketId))
    .map((b) => `<option value="${b.id}" ${b.id === bucketId ? "selected" : ""}>${esc(b.name)}</option>`)
    .join(
      "",
    )}</select></div></details><button class="btn" style="width:100%">${x ? "Save Changes" : "Save Expense"}</button></form>`;
}
function routingTransfersForIncome(incomeId) {
  return state.transfers.filter((t) => !t.deletedAt && t.sourceIncomeId === incomeId);
}
function incomeForm(x = null) {
  const p = currentPeriod(),
    type = x?.incomeType || "bonus",
    accountId = x?.accountId || "ctbc",
    period = x?.budgetPeriodId || p?.id || "";
  if (x && isClosedPeriod(x.budgetPeriodId))
    return `<div class="notice"><strong>${monthLabel(x.budgetPeriodId)} is closed.</strong><br>Reopen the month before editing this income entry.</div>`;
  const periods = state.periods.filter((y) => y.state !== "closed" || y.id === period);
  if (!periods.length) return `<div class="empty">Create or reopen a funding month first.</div>`;
  const defaultTithe = x ? !!x.titheEligible : ["regular_income", "bonus"].includes(type);
  const hasRouting = x ? routingTransfersForIncome(x.id).length > 0 : false;
  return `<form id="income-form"><input type="hidden" name="id" value="${x?.id || ""}"><div class="field"><label>Amount</label><input name="amount" type="number" min="0" step="1" value="${x?.amount || ""}" required></div><div class="field"><label>Income type</label><select name="type" id="income-type">${INCOME_TYPES.filter(
    (t) => t[0] !== "project_surplus",
  )
    .map((t) => `<option value="${t[0]}" ${t[0] === type ? "selected" : ""}>${t[1]}</option>`)
    .join(
      "",
    )}</select></div><div class="form-grid"><div class="field"><label>Date received</label><input name="date" type="date" value="${x?.dateReceived || today()}" required></div><div class="field"><label>Budget period</label><select name="period">${periods.map((y) => `<option value="${y.id}" ${y.id === period ? "selected" : ""}>${monthLabel(y.id)}</option>`).join("")}</select></div></div><div class="field"><label>Account</label><select name="account">${state.accounts
    .filter((a) => a.role !== "investment" && a.id !== "cash")
    .map((a) => `<option value="${a.id}" ${a.id === accountId ? "selected" : ""}>${esc(a.name)}</option>`)
    .join(
      "",
    )}</select></div><div class="field"><label>Description</label><input name="description" value="${esc(x?.description || "")}" placeholder="e.g. Bonus or camera sale"></div><label class="check-line"><input id="income-tithe" name="tithe" type="checkbox" ${defaultTithe ? "checked" : ""}> Tithe eligible</label>${!x ? `<label class="check-line"><input id="income-routing" name="routing" type="checkbox" ${type !== "regular_income" && type !== "reimbursement" ? "checked" : ""}> Open routing assistant after saving</label>` : ""}${hasRouting ? `<div class="notice"><strong>This income already has routing records.</strong><br>Delete any uncompleted routing transfers before changing the amount, type or tithe eligibility.</div>` : ""}<button class="btn" style="width:100%;margin-top:14px">${x ? "Save Changes" : "Save Income"}</button></form>`;
}
function incomeRoutingView(incomeId) {
  const i = state.incomes.find((x) => x.id === incomeId && !x.deletedAt);
  if (!i) return '<div class="empty">Income record not found.</div>';
  const existing = routingTransfersForIncome(incomeId);
  if (existing.length)
    return `<div class="notice"><strong>Routing already exists for this income.</strong><br>${existing.length} routing record${existing.length === 1 ? "" : "s"} are already linked to it. Manage planned transfers from Activity.</div>`;
  const pctValue = Number(state.settings.tithePercent || 10),
    tithe = i.titheEligible ? Math.round((Number(i.amount || 0) * pctValue) / 100) : 0,
    available = Math.max(0, Number(i.amount || 0) - tithe),
    active = activeGoal(state.goals, state.bucketBalances);
  return `<div class="notice"><strong>Nothing moves automatically.</strong><br>This assistant creates a clear plan for supplemental income. Physical transfers remain planned until you mark them completed.</div><section class="card routing-summary" style="margin-top:14px">${row("Income", money(i.amount))}${row("Tithe", i.titheEligible ? `${money(tithe)} · ${pctValue}%` : "Not applicable")}${row("Available after tithe", money(available))}${row("Current priority", esc(active?.name || "Investments"))}</section><form id="income-routing-form" data-income="${i.id}"><div class="field"><label>What should the after-tithe money do?</label><select name="strategy"><option value="priority">Current wealth priority</option><option value="emergency">Emergency Fund</option><option value="home-trip">Home Travel Fund</option><option value="equipment">Equipment Fund</option><option value="invest">Investments</option><option value="keep">Keep in operating cash</option></select></div><div class="field"><label>Amount to route after tithe</label><input name="routeAmount" type="number" min="0" step="1" max="${Math.round(available)}" value="${Math.round(available)}"></div><div class="sub">Any un-routed remainder stays in the income account as operating cash.</div><button class="btn" style="width:100%;margin-top:14px">Create Routing Plan</button><button class="btn secondary" type="button" style="width:100%;margin-top:8px" data-action="skip-income-routing">Skip for Now</button></form>`;
}

function manualTransferForm(x = null) {
  const p = currentPeriod(),
    period = x?.budgetPeriodId || p?.id || "";
  if (x && x.budgetPeriodId && isClosedPeriod(x.budgetPeriodId))
    return `<div class="notice"><strong>${monthLabel(x.budgetPeriodId)} is closed.</strong><br>Reopen the month before editing this transfer.</div>`;
  const alloc = x ? state.transferAllocations.find((a) => a.transferId === x.id) : null,
    selectedBucket = x?._bucketId || alloc?.bucketId || "";
  const periods = state.periods.filter((y) => y.state !== "closed" || y.id === period);
  return `<form id="manual-transfer-form"><input type="hidden" name="id" value="${x?.id || ""}"><div class="field"><label>Amount</label><input name="amount" type="number" min="0" step="1" value="${x?.amount || ""}" required></div><div class="form-grid"><div class="field"><label>From account</label><select name="from">${state.accounts
    .filter((a) => a.id !== "cash")
    .map(
      (a) =>
        `<option value="${a.id}" ${a.id === (x?.fromAccountId || "ctbc") ? "selected" : ""}>${esc(a.name)}</option>`,
    )
    .join("")}</select></div><div class="field"><label>To account</label><select name="to">${state.accounts
    .filter((a) => a.id !== "cash")
    .map(
      (a) => `<option value="${a.id}" ${a.id === (x?.toAccountId || "esun") ? "selected" : ""}>${esc(a.name)}</option>`,
    )
    .join(
      "",
    )}</select></div></div><div class="field"><label>Purpose / virtual bucket</label><select name="bucket"><option value="">No bucket allocation</option>${state.buckets.map((b) => `<option value="${b.id}" ${b.id === selectedBucket ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${x?.completedDate || x?.plannedDate || today()}"></div><div class="field"><label>Budget period</label><select name="period"><option value="">None</option>${periods.map((y) => `<option value="${y.id}" ${y.id === period ? "selected" : ""}>${monthLabel(y.id)}</option>`).join("")}</select></div></div><label><input name="completed" type="checkbox" ${!x || x.status === "completed" ? "checked" : ""}> Transfer already completed</label><button class="btn" style="width:100%;margin-top:14px">${x ? "Save Changes" : "Save Transfer"}</button></form>`;
}
function transferConfirm(id) {
  const t = state.transfers.find((x) => x.id === id);
  if (!t) return "";
  const allocs = state.transferAllocations.filter((a) => a.transferId === id);
  const details = allocs.length
    ? allocs
        .map((a) => row(`Virtual · ${bucket(a.bucketId)?.name || a.label || "Allocation"}`, `+${money(a.amount)}`))
        .join("")
    : "";
  return `<div class="notice">Confirm only after you actually moved the money in your banking app. This transfer does not count as spending.</div><div class="section-title"><h2>Impact preview</h2></div><section class="card">${row(`Physical · ${physicalAccount(t.fromAccountId)?.name || t.fromAccountId}`, `−${money(t.amount)}`)}${row(`Physical · ${physicalAccount(t.toAccountId)?.name || t.toAccountId}`, `+${money(t.amount)}`)}${details}${row("Spending impact", money(0))}<div class="row"><strong>Total bank movement</strong><strong>${money(t.amount)}</strong></div></section><div class="actions" style="margin-top:14px"><button class="btn" data-action="confirm-transfer" data-id="${id}">Yes — Transfer Completed</button><button class="btn secondary" data-action="close-modal">Not Yet</button></div>`;
}
function paydayTransferConfirm(periodId, accountId) {
  const req = paydayRequirements(periodId),
    group = req.groups.find((g) => g.accountId === accountId);
  if (!group) return `<div class="notice">This payday transfer is already fully satisfied.</div>`;
  const destination = physicalAccount(accountId)?.name || accountId;
  return `<div class="notice">Confirm only after you physically moved this exact remaining amount. Already-completed payday items are excluded automatically. Transfers are not spending.</div><div class="section-title"><h2>Impact preview</h2></div><section class="card">${row("Physical · CTBC Operating", `−${money(group.amount)}`)}${row(`Physical · ${destination}`, `+${money(group.amount)}`)}${group.items
    .filter((x) => x.bucketId)
    .map((x) => row(`Virtual · ${x.label}`, `+${money(x.remaining)}`))
    .join(
      "",
    )}${row("Spending impact", money(0))}<div class="row"><strong>Total bank movement</strong><strong>${money(group.amount)}</strong></div></section><div class="actions" style="margin-top:14px"><button class="btn" data-action="confirm-payday-transfer" data-period="${periodId}" data-account="${accountId}">Yes — Transfer Completed</button><button class="btn secondary" data-action="close-modal">Not Yet</button></div>`;
}
function monthCloseView() {
  const p = currentPeriod();
  if (!p) return "";
  const c = monthCloseStatus(p.id),
    closeRecord = state.monthlyCloses.find((x) => x.budgetPeriodId === p.id || x.id === p.id),
    health = dataHealthReport();
  if (p.state === "closed") {
    const accounts = closeRecord?.endingAccountBalances || {};
    return `<div class="notice"><strong>${monthLabel(p.id)} is closed.</strong><br>This month-end snapshot is read-only until you intentionally reopen the month.</div>
    <div class="grid g2" style="margin-top:14px"><section class="card"><div class="metric-label">Expenses</div><div class="metric">${money(closeRecord?.expenses ?? totalExpenses(p.id))}</div></section><section class="card"><div class="metric-label">Core wealth contributed</div><div class="metric">${privateMoney(closeRecord?.wealthContribution ?? completedCoreWealth(p.id))}</div></section></div>
    <div class="section-title"><h2>Saved month-end snapshot</h2><span class="tag good-tag">Locked</span></div><section class="card">
      ${row("Closed", esc((closeRecord?.closedAt || p.closedAt || "").slice(0, 10)))}
      ${row("Ending Core Wealth", privateMoney(closeRecord?.endingCoreWealth ?? state.wealth.coreWealth))}
      ${row("Ending Financial Net Worth", privateMoney(closeRecord?.endingFinancialNetWorth ?? state.wealth.financialNetWorth))}
      ${row("CTBC", privateMoney(accounts.ctbc ?? closeRecord?.ctbcActual ?? 0))}
      ${row("E.SUN", privateMoney(accounts.esun ?? closeRecord?.esunActual ?? 0))}
      ${row("Cash Wallet", privateMoney(accounts.cash ?? 0))}
      ${row("IBKR (TWD)", privateMoney(accounts.ibkrTwd ?? 0))}
    </section><button class="btn secondary" style="width:100%;margin-top:14px" data-action="reopen-period" data-id="${p.id}">Reopen Month</button>`;
  }
  const fixedText = c.missingFixed.length
    ? `${c.missingFixed.length} fixed obligation${c.missingFixed.length === 1 ? "" : "s"} not recorded`
    : "All fixed obligations recorded";
  const steps = [
    [
      "1",
      "Transactions",
      c.pending.length === 0 && c.missingFixed.length === 0,
      c.pending.length
        ? `${c.pending.length} planned transfer${c.pending.length === 1 ? "" : "s"} still pending`
        : fixedText,
    ],
    [
      "2",
      "Payday allocations",
      c.fundingOk,
      c.fundingOk
        ? "Tithe, CTBC reserves and wealth routing complete"
        : `${money(c.payday.totalOutstanding)} of payday bank transfers still outstanding`,
    ],
    [
      "3",
      "Account reconciliation",
      c.bankOk,
      c.bankOk ? "CTBC and E.SUN are reconciled" : "Update CTBC/E.SUN and resolve E.SUN purpose allocation",
    ],
    [
      "4",
      "Month-end sweep",
      c.sweep.available <= 0.5 && c.sweep.overSwept <= 0.5,
      c.sweep.overSwept > 0
        ? `${money(c.sweep.overSwept)} over-swept`
        : c.sweep.available > 0
          ? `${money(c.sweep.available)} still available`
          : "Sweep is complete",
    ],
    [
      "5",
      "Snapshot & lock",
      c.ready,
      c.ready ? "Ready to save the month-end snapshot and lock the month" : "Complete the earlier steps first",
    ],
  ];
  let action = "";
  if (c.pending.length)
    action = `<div class="notice" style="margin-top:14px">Complete or remove all planned transfers before creating the sweep or closing the month.</div>`;
  else if (c.sweep.overSwept > 0.5)
    action = `<div class="notice danger-notice" style="margin-top:14px"><strong>Sweep correction required.</strong><br>The completed sweep exceeds the amount currently supported by this budget by ${money(c.sweep.overSwept)}. Correct the transactions or record the appropriate reverse movement before closing.</div>`;
  else if (c.sweep.available > 0.5)
    action = `<button class="btn" style="width:100%;margin-top:14px" data-action="create-sweep">Create ${money(c.sweep.available)} Sweep Transfer</button>`;
  else if (!c.fundingOk || !c.bankOk)
    action = `<div class="notice" style="margin-top:14px">Resolve the funding and reconciliation steps above before closing the month.</div>`;
  else
    action = `${c.missingFixed.length ? `<div class="notice" style="margin-top:14px"><strong>Review fixed obligations.</strong><br>${fixedText}. You can close only after confirming this is intentional.</div>` : ""}<button class="btn" style="width:100%;margin-top:14px" data-action="close-period">Save Snapshot & Close ${monthLabel(p.id)}</button>`;
  const snapshotRows = `${row("Income", privateMoney(periodAllIncome(p.id)))}${row("Expenses", money(totalExpenses(p.id)))}${row("Core wealth contributed", privateMoney(completedCoreWealth(p.id)))}${row("Ending Core Wealth", privateMoney(state.wealth.coreWealth))}${row("Ending Financial Net Worth", privateMoney(state.wealth.financialNetWorth))}${row("CTBC tracked", privateMoney(c.ct.actual))}${row("E.SUN tracked", privateMoney(c.es.actual))}${row("Cash Wallet", privateMoney(accountSnapshot("cash").actual))}${row("IBKR", privateMoney(latestInvestmentTwd()))}`;
  const healthText = health.critical
    ? `${health.critical} critical Data Health issue${health.critical === 1 ? "" : "s"}`
    : health.warn
      ? `${health.warn} Data Health warning${health.warn === 1 ? "" : "s"}`
      : "No Data Health warnings";
  const sweepNotes = [
    c.sweep.billSavings > 0.5 ? `Includes ${money(c.sweep.billSavings)} saved on fixed bills.` : "",
    c.sweep.billOverages > 0.5 ? `Fixed bills came in ${money(c.sweep.billOverages)} over budget.` : "",
    c.sweep.paydayOverSent > 0.5
      ? `${money(c.sweep.paydayOverSent)} less, because payday already sent that much more than the updated budget allows.`
      : "",
  ].filter(Boolean);
  return `<div class="grid g2"><section class="card"><div class="metric-label">${c.sweep.rules >= 2 ? "Unused budget" : "Unused flexible + buffer"}</div><div class="metric">${money(c.sweep.grossUnused)}</div>${c.sweep.rules >= 2 ? `<div class="sub">Flexible caps, buffer and fixed-bill savings</div>` : ""}</section><section class="card"><div class="metric-label">Overspending deficits</div><div class="metric ${c.sweep.deficits ? "bad" : ""}">${money(c.sweep.deficits)}</div></section></div>
  <section class="card" style="margin-top:14px"><div class="metric-label">Available month-end sweep</div><div class="metric">${money(c.sweep.available)}</div><div class="sub">Only this funding month is included; next-month income is excluded.${sweepNotes.length ? ` ${sweepNotes.join(" ")}` : ""}</div></section>
  <div class="section-title"><h2>Guided close</h2><span class="sub">Five-step month operation</span></div><section class="card close-checklist">${steps.map(([n, label, ok, detail]) => `<div class="close-check"><span class="check-dot ${ok ? "ok" : "attention"}">${ok ? "✓" : n}</span><div><strong>${label}</strong><div class="sub">${detail}</div></div></div>`).join("")}</section>
  <div class="section-title"><h2>Snapshot preview</h2><span class="sub">Saved when you close</span></div><section class="card">${snapshotRows}</section>
  <div class="notice ${health.critical ? "danger-notice" : ""}" style="margin-top:14px"><strong>Data Health: ${esc(healthText)}</strong><br>Data Health does not automatically change your records. <button class="text-btn" data-action="data-health">Review details</button></div>${action}`;
}
function goalEditForm(goalId) {
  const g = goal(goalId);
  if (!g) return `<div class="empty">Goal not found.</div>`;
  const prereq = g.prerequisiteGoalId ? goal(g.prerequisiteGoalId) : null;
  return `<form id="goal-edit-form" data-goal="${g.id}"><div class="field"><label>Target amount</label><input name="targetAmount" type="number" min="0" step="1000" value="${Number(g.targetAmount || 0)}" required></div><div class="form-grid"><div class="field"><label>Target date (optional)</label><input name="targetDate" type="date" value="${g.targetDate || ""}"></div><div class="field"><label>Monthly target (optional)</label><input name="monthlyTarget" type="number" min="0" step="1000" value="${Number(g.monthlyTarget || 0)}"></div></div><div class="field"><label>Status</label><select name="status"><option value="active" ${g.status === "active" ? "selected" : ""}>Active</option><option value="waiting" ${g.status === "waiting" ? "selected" : ""}>Waiting</option><option value="paused" ${g.status === "paused" ? "selected" : ""}>Paused</option></select></div>${prereq ? `<div class="notice">Funding prerequisite: ${esc(prereq.name)} must reach ${money(g.prerequisiteAmount || 0)}. This routing dependency is preserved.</div>` : ""}<button class="btn" style="width:100%;margin-top:14px">Save Goal</button></form>`;
}
function goalContributionForm(goalId) {
  const g = goal(goalId);
  if (!g) return `<div class="empty">Goal not found.</div>`;
  const b = bucket(g.bucketId);
  if (!b) return `<div class="empty">Goal bucket not found.</div>`;
  const openPeriods = state.periods.filter((p) => p.state !== "closed");
  return `<form id="goal-contribution-form" data-goal="${g.id}"><div class="notice">This records a real transfer into ${esc(g.name)}. Confirm completion only after you actually move the money.</div><div class="field" style="margin-top:14px"><label>Contribution amount</label><input name="amount" type="number" min="1" step="1" required></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Funding month (optional)</label><select name="period"><option value="">None</option>${openPeriods.map((p) => `<option value="${p.id}" ${p.id === selectedPeriodId ? "selected" : ""}>${monthLabel(p.id)}</option>`).join("")}</select></div></div><label><input name="completed" type="checkbox"> Transfer already completed</label><button class="btn" style="width:100%;margin-top:14px">Save Goal Contribution</button></form>`;
}
function cashTransferForm(mode = "withdrawal") {
  const withdrawal = mode === "withdrawal",
    cash = accountSnapshot("cash"),
    ct = accountSnapshot("ctbc"),
    period = entryPeriodId() || "";
  const periods = state.periods.filter((p) => p.state !== "closed");
  return `<form id="cash-transfer-form" data-mode="${mode}"><div class="notice"><strong>${withdrawal ? "ATM withdrawal" : "Cash deposit"}</strong><br>${withdrawal ? "Money moves from CTBC Operating to Cash Wallet. It is a transfer, not an expense." : "Money moves from Cash Wallet back to CTBC Operating. It is a transfer, not income."}</div><div class="grid g2" style="margin-top:12px"><section class="card nested-card"><div class="metric-label">CTBC tracked</div><strong>${money(ct.actual)}</strong></section><section class="card nested-card"><div class="metric-label">Cash on hand</div><strong>${money(cash.actual)}</strong></section></div><div class="field" style="margin-top:14px"><label>Amount</label><input name="amount" type="number" min="1" step="1" required></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Funding month</label><select name="period"><option value="">None</option>${periods.map((p) => `<option value="${p.id}" ${p.id === period ? "selected" : ""}>${monthLabel(p.id)}</option>`).join("")}</select></div></div><button class="btn" style="width:100%">${withdrawal ? "Record Cash Withdrawal" : "Record Cash Deposit"}</button></form>`;
}

function investmentForm() {
  const snap = [...state.investmentSnapshots].sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1),
    estimated = Number(state.accountBalances?.ibkr ?? snap?.value ?? 0);
  return `<form id="investment-form"><div class="notice">Enter the total portfolio value shown in IBKR. This snapshot replaces the interim estimate from any contributions recorded since the previous snapshot.</div><div class="field" style="margin-top:14px"><label>IBKR portfolio value (USD)</label><input name="value" type="number" step="0.01" value="${estimated.toFixed(2)}" required></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>USD/TWD rate</label><input name="fx" type="number" step="0.0001" value="${state.settings.usdTwdRate}" required></div></div><button class="btn" style="width:100%">Save Snapshot</button></form>`;
}
function accountReconciliationForm(accountId) {
  const a = physicalAccount(accountId),
    snap = accountId === "esun" ? esunSnapshot() : accountSnapshot(accountId),
    isCash = accountId === "cash";
  return `<form id="account-reconcile-form" data-account="${accountId}"><div class="notice">${isCash ? "Count the physical cash you actually have." : "Enter the exact balance shown in your " + esc(a?.name || "bank") + " app."} Nothing is changed until you review and confirm the impact.</div><div class="field" style="margin-top:14px"><label>${isCash ? "Actual cash on hand" : "Actual bank balance"}</label><input name="actualBalance" type="number" step="1" min="0" value="${Math.round(snap.actual)}" required></div><div class="form-grid"><div class="field"><label>Date checked</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Current tracked balance</label><input type="text" value="${money(snap.actual)}" disabled></div></div><div class="field"><label>Note (optional)</label><input name="note" placeholder="${isCash ? "Counted physical cash" : "Checked in bank app"}"></div><button class="btn" style="width:100%">Review Balance Update</button></form>`;
}
function accountAdjustmentForm(accountId) {
  const snap = accountSnapshot(accountId);
  return `<form id="account-adjustment-form" data-account="${accountId}"><div class="notice">Use an adjustment only when the difference is real and is not better recorded as an expense, income or transfer.</div><div class="field" style="margin-top:14px"><label>Adjustment amount</label><input name="amount" type="number" step="1" value="${Math.round(snap.difference) || ""}" placeholder="Use + to add or − to subtract" required></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Current bank vs ledger</label><input type="text" value="${snap.difference > 0 ? "+" : ""}${money(snap.difference)}" disabled></div></div><div class="field"><label>Reason</label><input name="note" placeholder="Bank interest, correction, opening-balance fix..." required></div><button class="btn" style="width:100%">Save Adjustment</button></form>`;
}
function esunAllocationForm() {
  const es = esunSnapshot();
  const diff = Number(modal.amount ?? es.unassigned);
  const reducing = diff < 0;
  const amount = Math.abs(diff);
  return `<form id="esun-allocation-form"><div class="notice"><strong>${reducing ? "Reduce" : "Assign"} ${money(amount)}</strong><br>${reducing ? "Choose which virtual buckets should be reduced." : "Choose what the unassigned E.SUN money is for."} You can split it across several buckets or leave part unassigned.</div><div class="allocation-fields">${state.buckets
    .filter((b) => b.accountId === "esun" && (b.active !== false || Math.abs(Number(state.bucketBalances[b.id] || 0)) > 0.5))
    .map(
      (b) =>
        `<div class="allocation-row"><div><strong>${esc(b.name)}</strong><div class="sub">Current ${money(state.bucketBalances[b.id] || 0)}</div></div><input name="bucket-${b.id}" type="number" min="0" step="1" value="0" ${reducing ? `max="${Math.max(0, Math.floor(state.bucketBalances[b.id] || 0))}"` : ""}></div>`,
    )
    .join(
      "",
    )}</div><input type="hidden" name="direction" value="${reducing ? "-1" : "1"}"><input type="hidden" name="limit" value="${amount}"><div class="sub" style="margin:10px 0">Maximum to ${reducing ? "reduce" : "assign"} now: ${money(amount)}</div><button class="btn" style="width:100%">Save Purpose Allocation</button></form>`;
}

function reconciliationPreviewView() {
  const d = modal.draft || {},
    accountId = d.accountId,
    a = physicalAccount(accountId),
    snap = accountId === "esun" ? esunSnapshot() : accountSnapshot(accountId),
    isCash = accountId === "cash";
  const actual = Number(d.actualBalance || 0),
    difference = actual - Number(snap.actual || 0);
  const es = accountId === "esun" ? esunSnapshot() : null;
  const purposeAfter = es ? actual - Number(es.virtualTotal || 0) : null;
  return `<div class="notice"><strong>No transaction will be created.</strong><br>This only establishes a new verified ${isCash ? "cash-count" : "account"} baseline. Existing expenses, income, transfers and virtual allocations remain unchanged.</div>
  <section class="card audit-summary" style="margin-top:14px">
    ${row("Account", esc(a?.name || accountId))}
    ${row("Current tracked balance", money(snap.actual))}
    ${row(isCash ? "Cash counted" : "Bank balance entered", money(actual))}
    ${row("Difference to acknowledge", `${difference > 0 ? "+" : ""}${money(difference)}`)}
    ${row("Date checked", esc(d.date || today()))}
  </section>
  ${es ? `<section class="card" style="margin-top:12px"><div class="metric-label">E.SUN purpose impact</div>${row("Current virtual allocation", money(es.virtualTotal))}${row("Unassigned after new baseline", `${purposeAfter > 0 ? "+" : ""}${money(purposeAfter)}`)}<div class="sub">If this is not zero, Wealth OS will ask you to assign or reduce purpose buckets after the bank baseline is saved.</div></section>` : ""}
  <div class="actions" style="margin-top:14px"><button class="btn" data-action="confirm-reconciliation">Confirm New Baseline</button><button class="btn secondary" data-action="account-reconcile" data-id="${accountId}">Go Back</button></div>`;
}
function accountAuditView(accountId) {
  const audit = accountAudit(accountId),
    snap = accountId === "esun" ? esunSnapshot() : accountSnapshot(accountId);
  const physical = audit.entries.length
    ? audit.entries
        .slice(-100)
        .map(
          (e) =>
            `<div class="audit-line"><div><strong>${esc(e.type)}</strong><div class="sub">${esc(e.date || "")} · ${esc(e.detail || "")}</div></div><div class="right"><strong class="${e.delta < 0 ? "bad" : e.delta > 0 ? "good" : ""}">${e.delta > 0 ? "+" : ""}${money(e.delta)}</strong><div class="sub">→ ${money(e.running)}</div></div></div>`,
        )
        .join("")
    : `<div class="empty compact-empty"><strong>No physical activity after the baseline.</strong><span>The tracked balance equals the verified baseline.</span></div>`;
  const purpose = audit.purposeEvents.length
    ? audit.purposeEvents
        .slice(0, 60)
        .map((ev) => {
          const t = ev.transfer,
            allocText = ev.allocations
              .map((a) => `${bucket(a.bucketId)?.name || a.bucketId} ${a.amount >= 0 ? "+" : ""}${money(a.amount)}`)
              .join(" · ");
          const physical = !isPurposeOnlyTransfer(t);
          return `<div class="audit-line"><div><strong>${physical ? "Bank transfer + purpose" : "Virtual allocation only"}</strong><div class="sub">${esc(t.completedDate || t.plannedDate || "")} · ${esc(allocText)}</div>${ev.reversedBy ? `<div class="sub good">Reversed by ${esc(ev.reversedBy.completedDate || ev.reversedBy.plannedDate || "later record")}</div>` : ""}</div><div class="right"><span class="tag ${physical ? "" : "good-tag"}">${physical ? "physical + virtual" : "virtual only"}</span>${canReversePurposeEvent(ev) ? `<button class="text-btn danger-text" data-action="reverse-allocation" data-id="${t.id}">Reverse</button>` : ""}</div></div>`;
        })
        .join("")
    : `<div class="empty compact-empty"><strong>No purpose-allocation history.</strong><span>Virtual bucket changes will appear here.</span></div>`;
  const buckets = state.buckets.filter((b) => b.accountId === accountId),
    crossDiff = Number(snap.rawExpected ?? snap.actual) - Number(audit.tracked || 0);
  return `<div class="privacy-all-money"><div class="notice"><strong>Audit view is read-only except explicit reversals.</strong><br>Physical money movements and virtual-purpose changes are shown separately so one cannot be mistaken for the other.</div>
  ${Math.abs(crossDiff) >= 0.5 ? `<div class="notice danger-notice" style="margin-top:12px"><strong>Historical ledger differs from the verified bank trail by ${crossDiff > 0 ? "+" : ""}${money(crossDiff)}.</strong><br>The verified bank baseline remains authoritative. Use the trail below to identify the historical record; do not create a compensating transaction just to force the old raw ledger to match.</div>` : ""}
  <section class="card audit-summary" style="margin-top:14px">
    ${row("Verified baseline", money(audit.baseline))}
    ${row("Baseline date", esc(audit.baselineDate || "Opening balance"))}
    ${row("Physical activity after baseline", `${audit.entries.reduce((s, e) => s + e.delta, 0) >= 0 ? "+" : ""}${money(audit.entries.reduce((s, e) => s + e.delta, 0))}`)}
    ${row("Tracked current balance", money(audit.tracked))}
    ${row("Raw ledger cross-check", money(snap.rawExpected ?? snap.actual))}
    ${row("Current screen balance", money(snap.actual))}
  </section>
  <div class="section-title"><h2>Physical bank trail</h2><span class="sub">Changes the bank balance</span></div><section class="card audit-list">${physical}</section>
  ${buckets.length ? `<div class="section-title"><h2>Current purpose buckets</h2><span class="sub">Does not move bank cash</span></div><section class="card">${buckets.map((b) => row(b.name, money(state.bucketBalances[b.id] || 0))).join("")}</section>` : ""}
  <div class="section-title"><h2>Purpose-allocation history</h2><span class="sub">Physical and virtual effects labeled separately</span></div><section class="card audit-list">${purpose}</section>
  ${accountId === "esun" ? `<button class="btn secondary" style="width:100%;margin-top:14px" data-action="esun-reallocate">Reallocate E.SUN Purpose</button>` : ""}</div>`;
}
function esunReallocationForm() {
  const buckets = state.buckets.filter((b) => b.accountId === "esun" && Number(state.bucketBalances[b.id] || 0) > 0);
  const all = state.buckets.filter((b) => b.accountId === "esun" && b.active !== false);
  if (!buckets.length) return `<div class="notice">There is no E.SUN bucket balance available to move.</div>`;
  return `<form id="esun-reallocation-form"><div class="notice"><strong>Virtual-purpose change only.</strong><br>This moves purpose between E.SUN buckets and does not change the physical E.SUN bank balance.</div><div class="form-grid" style="margin-top:14px"><div class="field"><label>Move from</label><select name="fromBucket">${buckets.map((b) => `<option value="${b.id}">${esc(b.name)} · ${money(state.bucketBalances[b.id] || 0)}</option>`).join("")}</select></div><div class="field"><label>Move to</label><select name="toBucket">${all.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}</select></div></div><div class="field"><label>Amount</label><input name="amount" type="number" min="1" step="1" required></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Bank impact</label><input type="text" value="NT$0" disabled></div></div><div class="field"><label>Note (optional)</label><input name="note" placeholder="Why the purpose changed"></div><button class="btn" style="width:100%">Save Virtual Reallocation</button></form>`;
}
function manualTransferReview() {
  const d = modal.draft || {},
    from = physicalAccount(d.from),
    to = physicalAccount(d.to),
    b = d.bucketId ? bucket(d.bucketId) : null;
  return `<div class="notice"><strong>${d.status === "completed" ? "Completed bank movement" : "Planned bank movement"}.</strong><br>${d.status === "completed" ? "Confirm only if the money has already moved in your bank." : "This will not affect balances until you later mark it completed."}</div><section class="card" style="margin-top:14px">${row("Physical · " + (from?.name || d.from), `−${money(d.amount)}`)}${row("Physical · " + (to?.name || d.to), `+${money(d.amount)}`)}${b ? row("Virtual · " + b.name, `+${money(d.amount)}`) : row("Virtual allocation", "None")}${row("Spending impact", money(0))}${row("Date", esc(d.date))}</section><div class="actions" style="margin-top:14px"><button class="btn" data-action="confirm-manual-transfer">Confirm & Save</button><button class="btn secondary" data-action="manual-transfer-back">Go Back</button></div></div>`;
}

function deleteFundingMonthView(periodId) {
  const p = state.periods.find((x) => x.id === periodId);
  if (!p) return '<div class="empty">Funding month not found.</div>';
  const incomes = state.incomes.filter((x) => x.budgetPeriodId === periodId && !x.deletedAt);
  const expenses = state.expenses.filter((x) => x.budgetPeriodId === periodId && !x.deletedAt);
  const transfers = state.transfers.filter((x) => x.budgetPeriodId === periodId && !x.deletedAt);
  const completed = transfers.filter(
    (x) =>
      x.status === "completed" &&
      !(x.systemGenerated && x.fromAccountId === x.toAccountId && x.transferType === "reserve_allocation"),
  );
  if (p.state === "closed")
    return `<div class="notice"><strong>${monthLabel(periodId)} is closed.</strong><br>Closed months are protected from deletion.</div>`;
  if (completed.length)
    return `<div class="notice"><strong>Deletion is blocked.</strong><br>This month has ${completed.length} completed transfer${completed.length === 1 ? "" : "s"}. Wealth OS will not silently reverse money you may have actually moved between accounts.</div><section class="card" style="margin-top:14px">${row("Income entries", incomes.length)}${row("Expenses", expenses.length)}${row("Transfers", transfers.length)}${row("Completed transfers", completed.length)}</section><div class="sub" style="margin-top:12px">If this was only a test, leave system transfers uncompleted before deleting the month.</div>`;
  return `<div class="notice"><strong>This action is intended for test or mistaken funding months.</strong><br>It will permanently remove the month and its period-linked entries from this device.</div><section class="card" style="margin-top:14px">${row("Funding month", monthLabel(periodId))}${row("Income entries", incomes.length)}${row("Expenses", expenses.length)}${row("Planned transfers", transfers.length)}</section><div class="sub" style="margin:12px 0">E.SUN/CTBC reconciliations, account adjustments, IBKR snapshots, and unrelated transactions are not touched.</div><button class="btn danger" style="width:100%" data-action="confirm-delete-period" data-id="${periodId}">Delete Month & Test Data</button>`;
}

// ---------- Categories & funds (v1.10.0) ----------
const RULE_LABEL = { fixed: "Fixed monthly", cap: "Flexible cap" };
function manageCategoriesView() {
  const editable = state.categories.filter((c) => ["fixed", "cap"].includes(c.ruleType)).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const rowFor = (c) =>
    `<div class="row"><div><strong>${esc(c.name)}</strong><div class="sub">${RULE_LABEL[c.ruleType]} · ${money(c.defaultAmount)}${c.active === false ? " · archived" : ""}</div></div><button class="btn ghost small" type="button" data-action="edit-category" data-id="${c.id}">Edit</button></div>`;
  const group = (title, list) => (list.length ? `<div class="section-title"><h2>${title}</h2></div><section class="card">${list.map(rowFor).join("")}</section>` : "");
  const active = editable.filter((c) => c.active !== false),
    archived = editable.filter((c) => c.active === false);
  return `<div class="notice">New and changed categories apply to future funding months. You can also refresh the selected open month when saving. Past expenses and closed months never change.</div>
  <button class="btn" style="width:100%;margin-top:12px" type="button" data-action="new-category">Add Category</button>
  ${group("Fixed monthly", active.filter((c) => c.ruleType === "fixed"))}${group("Flexible caps", active.filter((c) => c.ruleType === "cap"))}${group("Archived", archived)}
  <button class="btn ghost" style="width:100%;margin-top:14px" type="button" data-action="settings">Back to Settings</button>`;
}
function applyToMonthOption() {
  const p = currentPeriod();
  return p && p.state !== "closed"
    ? `<label class="sync-budget-option"><input type="checkbox" name="applyCurrentMonth" ${state.settings.applyBudgetChangesToCurrentMonth !== false ? "checked" : ""}><span><strong>Apply to ${monthLabel(p.id)}</strong><small>Refresh this open month's plan. Existing transactions stay exactly as recorded. If payday already moved more to wealth than the new plan allows, the month-end sweep is reduced to match.</small></span></label>`
    : "";
}
function categoryForm(c = null) {
  const used = c ? state.expenses.some((e) => !e.deletedAt && e.categoryId === c.id) : false;
  return `<form id="category-form" data-id="${c?.id || ""}"><div class="field"><label>Name</label><input name="name" required maxlength="40" value="${esc(c?.name || "")}" placeholder="e.g. Streaming, Pet care"></div>
  <div class="form-grid"><div class="field"><label>Type</label><select name="ruleType">${Object.entries(RULE_LABEL).map(([v, l]) => `<option value="${v}" ${(c?.ruleType || "cap") === v ? "selected" : ""}>${l}</option>`).join("")}</select></div><div class="field"><label>Monthly amount</label><input name="amount" type="number" min="0" step="1" inputmode="numeric" required value="${c ? Number(c.defaultAmount || 0) : ""}"></div></div>
  <div class="sub" style="margin-bottom:10px">Fixed monthly: bills you pay every month (shown under Recurring obligations). Flexible cap: a spending limit that counts toward the month-end sweep.</div>
  ${applyToMonthOption()}
  ${c ? `<label class="check-line"><input type="checkbox" name="archived" ${c.active === false ? "checked" : ""}> Archived (hidden from new expenses and future months${used ? "; past expenses keep it" : ""})</label>` : ""}
  <button class="btn" style="width:100%;margin-top:12px">${c ? "Save Category" : "Add Category"}</button></form>`;
}
async function saveCategory(form) {
  const fd = new FormData(form),
    id = form.dataset.id,
    stamp = new Date().toISOString(),
    existing = id ? category(id) : null,
    name = String(fd.get("name") || "").trim(),
    ruleType = fd.get("ruleType"),
    amount = Number(fd.get("amount"));
  if (!name) throw new Error("Enter a name.");
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Enter an amount of 0 or more.");
  if (state.categories.some((c) => c.id !== id && c.active !== false && c.name.trim().toLowerCase() === name.toLowerCase()))
    throw new Error(`There is already a category called ${name}.`);
  const group = ruleType === "fixed" ? "Fixed" : "Flexible";
  const sameGroup = state.categories.filter((c) => c.ruleType === ruleType);
  const record = existing
    ? { ...existing, name, ruleType, group, defaultAmount: amount, expectedEachMonth: ruleType === "fixed", active: !fd.get("archived"), updatedAt: stamp }
    : {
        id: uid("cat"),
        name,
        group,
        ruleType,
        expectedEachMonth: ruleType === "fixed",
        defaultAmount: amount,
        active: true,
        sort: Math.max(ruleType === "fixed" ? 20 : 40, ...sameGroup.map((c) => Number(c.sort || 0))) + 0.5,
        createdAt: stamp,
        updatedAt: stamp,
      };
  await put("categories", record);
  const categories = state.categories.filter((c) => c.id !== record.id).concat(record),
    selected = currentPeriod(),
    sync = !!form.querySelector('input[name="applyCurrentMonth"]')?.checked;
  if (sync && selected && selected.state !== "closed") await syncOpenMonthPlan(selected, categories, state.settings, stamp);
  modal = { type: "manage-categories" };
  await load();
}

function fundBuckets() {
  return state.buckets.filter((b) => b.bucketType === "sinking_fund");
}
function fundGoal(bucketId) {
  return state.goals.find((g) => g.bucketId === bucketId) || null;
}
function manageFundsView() {
  const rows = fundBuckets().map((b) => {
    const g = fundGoal(b.id),
      bal = Number(state.bucketBalances[b.id] || 0);
    return `<div class="row"><div><strong>${esc(b.name)}</strong><div class="sub">${privateMoney(bal)}${g?.targetAmount ? ` of ${money(g.targetAmount)}` : ""}${g?.monthlyTarget ? ` · ${money(g.monthlyTarget)}/month` : ""}${b.active === false ? " · archived" : g ? ` · ${esc(g.status)}` : ""}</div></div><button class="btn ghost small" type="button" data-action="edit-fund" data-id="${b.id}">Edit</button></div>`;
  });
  return `<div class="notice">A fund is money set aside in E.SUN for a planned purpose. It counts toward Financial Net Worth but not Core Wealth. With a monthly amount, it is funded from each paycheck's wealth capacity once it is active.</div>
  <button class="btn" style="width:100%;margin-top:12px" type="button" data-action="new-fund">Add Fund</button>
  <section class="card privacy-sensitive" style="margin-top:14px">${rows.join("") || `<div class="sub">No savings funds yet.</div>`}</section>
  <div class="sub" style="margin-top:10px">Targets, dates and status can also be changed from the Goals tab.</div>
  <button class="btn ghost" style="width:100%;margin-top:14px" type="button" data-action="settings">Back to Settings</button>`;
}
function fundForm(b = null) {
  const g = b ? fundGoal(b.id) : null,
    bal = b ? Number(state.bucketBalances[b.id] || 0) : 0;
  return `<form id="fund-form" data-id="${b?.id || ""}"><div class="field"><label>Name</label><input name="name" required maxlength="40" value="${esc(b?.name || "")}" placeholder="e.g. Car Fund"></div>
  ${b ? "" : `<div class="form-grid"><div class="field"><label>Target amount</label><input name="target" type="number" min="0" step="1000" inputmode="numeric" required></div><div class="field"><label>Monthly amount (optional)</label><input name="monthly" type="number" min="0" step="100" inputmode="numeric"></div></div><div class="field"><label>Status</label><select name="status"><option value="active">Active — fund from paychecks</option><option value="paused" selected>Paused — don't fund yet</option></select></div>`}
  ${b ? `<label class="check-line"><input type="checkbox" name="archived" ${b.active === false ? "checked" : ""} ${b.active !== false && Math.abs(bal) > 0.5 ? "disabled" : ""}> Archived${b.active !== false && Math.abs(bal) > 0.5 ? ` — move its ${money(bal)} balance first (Wealth → E.SUN → Reallocate)` : ""}</label>` : ""}
  <button class="btn" style="width:100%;margin-top:12px">${b ? "Save Fund" : "Add Fund"}</button></form>`;
}
async function saveFund(form) {
  const fd = new FormData(form),
    id = form.dataset.id,
    stamp = new Date().toISOString(),
    name = String(fd.get("name") || "").trim();
  if (!name) throw new Error("Enter a name.");
  if (state.buckets.some((b) => b.id !== id && b.name.trim().toLowerCase() === name.toLowerCase()))
    throw new Error(`There is already a fund called ${name}.`);
  if (id) {
    const b = bucket(id),
      g = fundGoal(id),
      archive = !!fd.get("archived");
    if (archive && b.active !== false && Math.abs(Number(state.bucketBalances[id] || 0)) > 0.5)
      throw new Error("Move this fund's balance to another purpose before archiving it.");
    await put("buckets", { ...b, name, active: !archive, updatedAt: stamp });
    if (g)
      await put("goals", {
        ...g,
        name,
        status: archive ? "archived" : g.status === "archived" ? "paused" : g.status,
        updatedAt: stamp,
      });
    for (const c of state.categories.filter((c) => c.defaultFundingBucketId === id && c.ruleType === "expense_only"))
      await put("categories", { ...c, name: c.name === `${b.name} spending` ? `${name} spending` : c.name, active: !archive, updatedAt: stamp });
  } else {
    const target = Number(fd.get("target")),
      monthly = Number(fd.get("monthly") || 0);
    if (!(target > 0)) throw new Error("Enter a target amount.");
    const bucketId = uid("fund");
    await put("buckets", {
      id: bucketId,
      name,
      accountId: "esun",
      bucketType: "sinking_fund",
      openingBalance: 0,
      countsTowardCoreWealth: false,
      countsTowardNetWorth: true,
      active: true,
      createdAt: stamp,
      updatedAt: stamp,
    });
    await put("goals", {
      id: uid("goal"),
      name,
      type: "sinking_fund",
      targetAmount: target,
      bucketId,
      targetDate: null,
      priority: Math.max(0, ...state.goals.map((g) => Number(g.priority || 0))) + 1,
      status: fd.get("status") === "active" ? "active" : "paused",
      prerequisiteGoalId: null,
      prerequisiteAmount: 0,
      monthlyTarget: monthly > 0 ? monthly : null,
      createdAt: stamp,
      updatedAt: stamp,
    });
    await put("categories", {
      id: uid("cat"),
      name: `${name} spending`,
      group: "Reserved Expense",
      ruleType: "expense_only",
      defaultAmount: 0,
      defaultFundingBucketId: bucketId,
      active: true,
      sort: Math.max(70, ...state.categories.map((c) => Number(c.sort || 0))) + 1,
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  modal = { type: "manage-funds" };
  await load();
}

function settingsView() {
  const lastBackup = state.settings.lastBackupAt ? new Date(state.settings.lastBackupAt).toLocaleString() : "Never";
  const backupAge = state.settings.lastBackupAt
    ? Math.floor((Date.now() - new Date(state.settings.lastBackupAt).getTime()) / 86400000)
    : null;
  const backupStatus =
    backupAge === null
      ? "No backup yet"
      : backupAge > 30
        ? `Backup is ${backupAge} days old`
        : backupAge === 0
          ? "Backed up today"
          : `Backed up ${backupAge} day${backupAge === 1 ? "" : "s"} ago`;
  const themePref = state.settings.theme || "system";
  return `<section class="card appearance-card"><div class="split"><div><div class="metric-label">Appearance</div><strong>Theme</strong><div class="sub">System follows your phone's light or dark setting.</div></div></div><div class="theme-switch" role="group" aria-label="Theme">${[
    ["system", "System"],
    ["light", "Light"],
    ["dark", "Dark"],
  ]
    .map(
      ([v, l]) =>
        `<button type="button" class="theme-option ${themePref === v ? "active" : ""}" data-action="set-theme" data-theme="${v}" aria-pressed="${themePref === v}">${l}</button>`,
    )
    .join(
      "",
    )}</div></section><section class="card app-info-card" style="margin-top:14px"><div class="split"><div><div class="metric-label">Installed build</div><strong>Wealth OS v${APP_VERSION}</strong><div class="sub">Data model ${DATA_MODEL_VERSION}</div></div><span class="tag good-tag">Local-first</span></div>${row("Privacy mode", state.settings.privacyMode ? "Sensitive balances hidden" : "Sensitive balances visible")}${row("Last backup", esc(lastBackup))}<div class="sub ${backupAge === null || backupAge > 30 ? "bad" : ""}" style="margin-top:8px">${esc(backupStatus)}</div><div class="actions settings-export-actions" style="margin-top:12px"><button class="btn secondary" data-action="export-backup">Export Backup</button><label class="btn secondary">Restore Backup<input id="restore-file" type="file" accept="application/json" hidden></label><button class="btn ghost" data-action="export-activity-csv">Activity CSV</button><button class="btn ghost" data-action="export-monthly-csv">Monthly CSV</button></div>${state.hasUndo ? `<div class="notice" style="margin-top:12px"><strong>Undo restore available.</strong><br>Your data from just before the last restore is kept on this device.<div class="actions" style="margin-top:10px"><button class="btn secondary" data-action="undo-restore">Undo restore</button><button class="btn ghost" data-action="discard-undo">Delete undo copy</button></div></div>` : ""}</section>
  <div class="section-title"><h2>Categories & funds</h2><span class="sub">Add, rename or archive</span></div><section class="card"><div class="row"><div><strong>Budget categories</strong><div class="sub">Fixed bills and flexible spending caps</div></div><button class="btn ghost small" type="button" data-action="manage-categories">Manage</button></div><div class="row"><div><strong>Savings funds</strong><div class="sub">Planned-use funds such as travel or equipment</div></div><button class="btn ghost small" type="button" data-action="manage-funds">Manage</button></div></section>
  <div class="section-title"><h2>Reliability tools</h2><span class="sub">Inspect before correcting</span></div><section class="card"><div class="row"><div><strong>Data Health</strong><div class="sub">Duplicates, stale reconciliations, bucket mismatches and month-state checks</div></div><button class="btn ghost small" type="button" data-action="data-health">Run Check</button></div><div class="row"><div><strong>CTBC audit trail</strong><div class="sub">Verified baseline + physical movements + virtual reserves</div></div><button class="btn ghost small" type="button" data-action="account-audit" data-id="ctbc">Open</button></div><div class="row"><div><strong>E.SUN audit trail</strong><div class="sub">Bank movements separated from purpose allocations</div></div><button class="btn ghost small" type="button" data-action="account-audit" data-id="esun">Open</button></div></section>
  <form id="settings-form"><div class="section-title"><h2>Planning settings</h2></div><div class="form-grid"><div class="field"><label>Fallback forecast salary</label><input name="forecastSalary" type="number" value="${state.settings.forecastSalary}"><div class="sub">Used only when no real paycheck history exists.</div></div><div class="field"><label>USD/TWD rate</label><input name="usdTwdRate" type="number" step="0.0001" value="${state.settings.usdTwdRate}"></div><div class="field"><label>Raise → wealth (%)</label><input name="wealthRaisePercent" type="number" min="0" max="100" value="${state.settings.wealthRaisePercent}"></div></div>
  <div class="section-title"><h2>Forecast assumptions</h2><span class="sub">Salary growth and returns are independent</span></div><div class="grid g3 scenario-settings"><section class="card nested-card"><strong>Conservative</strong><div class="field"><label>Investment return (%)</label><input name="conservativeInvestmentReturn" type="number" step="0.1" value="${state.settings.conservativeInvestmentReturn ?? 4}"></div><div class="field"><label>Salary growth (%)</label><input name="conservativeSalaryGrowth" type="number" step="0.1" value="${state.settings.conservativeSalaryGrowth ?? 1}"></div></section><section class="card nested-card"><strong>Base</strong><div class="field"><label>Investment return (%)</label><input name="forecastInvestmentReturn" type="number" step="0.1" value="${state.settings.forecastInvestmentReturn ?? 7}"></div><div class="field"><label>Salary growth (%)</label><input name="forecastSalaryGrowth" type="number" step="0.1" value="${state.settings.forecastSalaryGrowth ?? 3}"></div></section><section class="card nested-card"><strong>Aggressive</strong><div class="field"><label>Investment return (%)</label><input name="aggressiveInvestmentReturn" type="number" step="0.1" value="${state.settings.aggressiveInvestmentReturn ?? 9}"></div><div class="field"><label>Salary growth (%)</label><input name="aggressiveSalaryGrowth" type="number" step="0.1" value="${state.settings.aggressiveSalaryGrowth ?? 5}"></div></section></div>
  <div class="section-title"><h2>Budget rules</h2></div><div class="notice">These values become the defaults for future funding months. You can also sync the changed limits into the currently selected open month. Actual expenses, transfers and closed months are never rewritten.</div>${currentPeriod() && currentPeriod().state !== "closed" ? `<label class="sync-budget-option"><input type="checkbox" name="applyCurrentMonth" ${state.settings.applyBudgetChangesToCurrentMonth !== false ? "checked" : ""}><span><strong>Apply changes to ${monthLabel(currentPeriod().id)}</strong><small>Refresh this open month's budget thresholds and plan only. Existing transactions stay exactly as recorded. If payday already moved more to wealth than the new plan allows, the month-end sweep is reduced to match.</small></span></label>` : `<div class="sub" style="margin:10px 0">No open selected funding month is available to sync.</div>`}${state.categories
    .filter((c) => c.ruleType !== "expense_only" && c.active !== false)
    .map(
      (c) =>
        `<div class="row"><div><strong>${esc(c.name)}</strong><div class="sub">${c.ruleType.replaceAll("_", " ")}</div></div><input name="cat-${c.id}" aria-label="${esc(c.name)} monthly amount" inputmode="numeric" type="number" step="1" value="${c.defaultAmount}" class="settings-budget-input" style="width:120px;padding:9px;border:1px solid var(--input-line,#d1d5db);border-radius:9px;text-align:right"></div>`,
    )
    .join("")}<button class="btn" style="width:100%;margin-top:14px">Save Settings</button></form>`;
}

async function createPaycheck(form) {
  const fd = new FormData(form),
    amount = Number(fd.get("amount")),
    date = fd.get("date"),
    periodId = fd.get("period");
  if (state.periods.some((p) => p.id === periodId)) throw new Error("That budget month already exists.");
  const plan = buildBudgetPlan({ income: amount, categories: state.categories, settings: state.settings }),
    stamp = new Date().toISOString();
  const goalAllocs = allocateGoalSurplus({
    amount: Math.max(0, Math.round(plan.immediateWealth)),
    goals: state.goals,
    bucketBalances: state.bucketBalances,
  });
  await put("periods", {
    id: periodId,
    state: "funded",
    createdAt: stamp,
    fundedAt: date,
    planSnapshot: plan,
    paydayRoutingSnapshot: { goalAllocs: goalAllocs.map((a) => ({ ...a })), createdAt: stamp },
  });
  await put("incomes", {
    id: uid("inc"),
    dateReceived: date,
    budgetPeriodId: periodId,
    amount,
    incomeType: "regular_income",
    accountId: "ctbc",
    description: "Monthly salary",
    titheEligible: true,
    includedInRegularIncomeMetrics: true,
    systemGenerated: true,
    createdAt: stamp,
  });

  // Reserves that live in CTBC are funded by purpose designation, not by moving cash
  // to another bank. The money is already physically in CTBC when salary arrives.
  const ctbcReserveLines = plan.lines.filter(
    (x) =>
      x.ruleType === "sinking_contribution" &&
      x.bucketId &&
      bucket(x.bucketId)?.accountId === "ctbc" &&
      Number(x.budgetAmount || 0) > 0,
  );
  if (ctbcReserveLines.length) {
    const total = ctbcReserveLines.reduce((sum, x) => sum + Number(x.budgetAmount || 0), 0),
      tid = uid("tr");
    await put("transfers", {
      id: tid,
      fromAccountId: "ctbc",
      toAccountId: "ctbc",
      amount: total,
      budgetPeriodId: periodId,
      status: "completed",
      plannedDate: date,
      completedDate: date,
      completedAt: stamp,
      transferType: "reserve_allocation",
      affectsPhysicalBalance: false,
      systemGenerated: true,
      createdAt: stamp,
      updatedAt: stamp,
    });
    await bulkPut(
      "transferAllocations",
      ctbcReserveLines.map((x) => ({
        id: uid("ta"),
        transferId: tid,
        bucketId: x.bucketId,
        amount: Number(x.budgetAmount || 0),
        goalId: null,
        label: x.name,
      })),
    );
  }

  // Bank-transfer actions are now derived from the funding plan and what has already
  // been completed. This prevents a separately-recorded tithe transfer from leaving
  // behind an obsolete combined payday transfer.
  selectedPeriodId = periodId;
  modal = null;
  await load();
  toast(`${monthLabel(periodId)} funding plan created`, "good");
}
async function saveExpense(form) {
  const fd = new FormData(form),
    id = fd.get("id"),
    existing = id ? state.expenses.find((x) => x.id === id) : null;
  const periodId = existing?.budgetPeriodId || fd.get("periodId") || selectedPeriodId;
  assertPeriodEditable(periodId);
  const cat = category(fd.get("category"));
  let fundingBucketId = fd.get("fundingBucket") || cat?.defaultFundingBucketId || null;
  let accountId = fd.get("account");
  if (fundingBucketId) {
    const b = bucket(fundingBucketId);
    if (b?.accountId) accountId = b.accountId;
  }
  const obj = {
    ...(existing || {}),
    id: existing?.id || uid("exp"),
    amount: Number(fd.get("amount")),
    categoryId: fd.get("category"),
    date: fd.get("date"),
    accountId,
    budgetPeriodId: periodId,
    description: fd.get("description") || "",
    fundingBucketId,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await put("expenses", obj);
  pendingHighlight = `expense:${obj.id}`;
  modal = null;
  await load();
  toast(...expenseSavedText(obj, !!existing));
}
// The message after saving an expense: what was saved and where that leaves its category this month.
function expenseSavedText(x, edited) {
  const c = category(x.categoryId),
    name = c?.name || "Expense",
    amt = money(x.amount);
  if (edited) return [`${name} · ${amt} updated`, ""];
  if (c?.ruleType === "fixed") return [`${name} paid · ${amt}`, "good"];
  const line = c?.ruleType === "cap" ? planFor(x.budgetPeriodId).lines.find((l) => l.id === c.id) : null;
  if (line && Number(line.budgetAmount || 0) > 0) {
    const left = Number(line.budgetAmount || 0) - Number(expenseTotals(x.budgetPeriodId)[c.id] || 0);
    return left >= 0 ? [`${name} · ${amt} saved · ${money(left)} left`, ""] : [`${name} · ${amt} saved · ${money(-left)} over`, "bad"];
  }
  const fund = x.fundingBucketId ? bucket(x.fundingBucketId) : null;
  return [`${name} · ${amt} saved${fund ? ` · from ${fund.name}` : ""}`, ""];
}
function prepareManualTransfer(form) {
  const fd = new FormData(form),
    id = fd.get("id") || null,
    existing = id ? state.transfers.find((x) => x.id === id) : null;
  const amount = Number(fd.get("amount")),
    from = fd.get("from"),
    to = fd.get("to"),
    periodId = fd.get("period") || null,
    bucketId = fd.get("bucket") || null;
  if (amount <= 0) throw new Error("Enter a transfer amount greater than zero.");
  if (from === "cash" || to === "cash")
    throw new Error(
      "Use Withdraw Cash or Deposit Cash for Cash Wallet movements. Cash can only move between CTBC Operating and Cash Wallet.",
    );
  if (from === to) throw new Error("From and to accounts must be different for a bank transfer.");
  assertPeriodEditable(periodId || existing?.budgetPeriodId || null);
  if (bucketId) {
    const b = bucket(bucketId);
    if (b?.accountId !== to)
      throw new Error(
        `${b?.name || "Selected bucket"} belongs to ${physicalAccount(b?.accountId)?.name || "another account"}, not ${physicalAccount(to)?.name || "the destination account"}.`,
      );
  }
  modal = {
    type: "manual-transfer-review",
    draft: {
      id,
      amount,
      from,
      to,
      periodId,
      status: fd.get("completed") === "on" ? "completed" : "planned",
      date: fd.get("date") || today(),
      bucketId,
    },
  };
  render();
}
async function commitManualTransfer() {
  const d = modal?.draft;
  if (!d) throw new Error("Transfer preview is no longer available.");
  const existing = d.id ? state.transfers.find((x) => x.id === d.id) : null;
  assertPeriodEditable(d.periodId || existing?.budgetPeriodId || null);
  const tid = existing?.id || uid("tr"),
    stamp = new Date().toISOString();
  await put("transfers", {
    ...(existing || {}),
    id: tid,
    fromAccountId: d.from,
    toAccountId: d.to,
    amount: d.amount,
    budgetPeriodId: d.periodId,
    status: d.status,
    plannedDate: d.date,
    completedDate: d.status === "completed" ? d.date : null,
    completedAt: d.status === "completed" ? existing?.completedAt || stamp : null,
    transferType: "manual",
    affectsPhysicalBalance: true,
    createdAt: existing?.createdAt || stamp,
    updatedAt: stamp,
    deletedAt: null,
  });
  for (const a of state.transferAllocations.filter((a) => a.transferId === tid))
    await remove("transferAllocations", a.id);
  if (d.bucketId)
    await put("transferAllocations", {
      id: uid("ta"),
      transferId: tid,
      bucketId: d.bucketId,
      amount: d.amount,
      goalId: null,
      label: "Manual allocation",
    });
  pendingHighlight = `transfer:${tid}`;
  modal = null;
  await load();
  toast(existing ? "Transfer updated" : `Transfer saved · ${money(d.amount)}`);
}

async function saveIncome(form) {
  const fd = new FormData(form),
    id = fd.get("id"),
    type = fd.get("type"),
    existing = id ? state.incomes.find((x) => x.id === id) : null,
    periodId = fd.get("period");
  assertPeriodEditable(periodId || existing?.budgetPeriodId || null);
  const amount = Number(fd.get("amount")),
    titheEligible = fd.get("tithe") === "on";
  if (existing && routingTransfersForIncome(existing.id).length) {
    const changed =
      amount !== Number(existing.amount || 0) ||
      type !== existing.incomeType ||
      titheEligible !== !!existing.titheEligible ||
      fd.get("account") !== existing.accountId ||
      periodId !== existing.budgetPeriodId;
    if (changed)
      throw new Error(
        "This income already has routing records. Delete any uncompleted routing transfers before changing the amount, type, account, period or tithe eligibility.",
      );
  }
  const incomeId = existing?.id || uid("inc");
  await put("incomes", {
    ...(existing || {}),
    id: incomeId,
    amount,
    incomeType: type,
    dateReceived: fd.get("date"),
    accountId: fd.get("account"),
    budgetPeriodId: periodId,
    description: fd.get("description") || "",
    titheEligible,
    includedInRegularIncomeMetrics: type === "regular_income",
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  });
  pendingHighlight = `income:${incomeId}`;
  if (!existing && type !== "regular_income" && fd.get("routing") === "on") {
    modal = { type: "income-routing", incomeId };
    await load();
    toast(`Income saved · ${money(amount)}`, "good");
    return;
  }
  modal = null;
  await load();
  toast(`${existing ? "Income updated" : "Income saved"} · ${money(amount)}`, "good");
}
async function saveIncomeRouting(form) {
  const incomeId = form.dataset.income,
    i = state.incomes.find((x) => x.id === incomeId && !x.deletedAt);
  if (!i) throw new Error("Income record not found.");
  assertPeriodEditable(i.budgetPeriodId || null);
  if (routingTransfersForIncome(incomeId).length) throw new Error("Routing already exists for this income.");
  const fd = new FormData(form),
    strategy = fd.get("strategy"),
    tithePct = Number(state.settings.tithePercent || 10),
    tithe = i.titheEligible ? Math.round((Number(i.amount || 0) * tithePct) / 100) : 0,
    available = Math.max(0, Number(i.amount || 0) - tithe),
    routeAmount = Number(fd.get("routeAmount") || 0);
  if (routeAmount < 0 || routeAmount > available + 0.5)
    throw new Error(`After-tithe routing cannot exceed ${money(available)}.`);
  const routes = [];
  if (tithe > 0) routes.push({ accountId: "esun", bucketId: "tithe", amount: tithe, label: "Tithe" });
  if (strategy !== "keep" && routeAmount > 0.5) {
    if (strategy === "priority") {
      const allocations = allocateGoalSurplus({
        amount: routeAmount,
        goals: state.goals,
        bucketBalances: state.bucketBalances,
      });
      for (const a of allocations) {
        if (a.bucketId)
          routes.push({
            accountId: bucket(a.bucketId)?.accountId,
            bucketId: a.bucketId,
            amount: Number(a.amount || 0),
            label: a.label || bucket(a.bucketId)?.name || "Goal",
          });
        else if (a.accountId)
          routes.push({
            accountId: a.accountId,
            bucketId: null,
            amount: Number(a.amount || 0),
            label: a.label || "Investments",
          });
      }
    } else if (strategy === "invest")
      routes.push({ accountId: "ibkr", bucketId: null, amount: routeAmount, label: "Investments" });
    else {
      const targetBucket = bucket(strategy);
      if (!targetBucket) throw new Error("Selected routing destination is not available.");
      const g = state.goals.find((x) => x.bucketId === strategy),
        room = g ? Math.max(0, Number(g.targetAmount || 0) - goalBal(g)) : Infinity;
      if (Number.isFinite(room) && routeAmount > room + 0.5)
        throw new Error(`${g.name} only has ${money(room)} remaining to its target.`);
      routes.push({
        accountId: targetBucket.accountId,
        bucketId: strategy,
        amount: routeAmount,
        label: targetBucket.name,
      });
    }
  }
  const groups = new Map();
  for (const r of routes.filter((r) => r.accountId && r.amount > 0.5)) {
    if (!groups.has(r.accountId)) groups.set(r.accountId, []);
    groups.get(r.accountId).push(r);
  }
  const stamp = new Date().toISOString(),
    date = i.dateReceived || today();
  for (const [dest, items] of groups) {
    const total = items.reduce((sum, x) => sum + Number(x.amount || 0), 0),
      same = dest === i.accountId,
      tid = uid("tr");
    await put("transfers", {
      id: tid,
      fromAccountId: i.accountId,
      toAccountId: dest,
      amount: total,
      budgetPeriodId: i.budgetPeriodId,
      status: same ? "completed" : "planned",
      plannedDate: date,
      completedDate: same ? date : null,
      completedAt: same ? stamp : null,
      transferType: same ? "supplemental_income_allocation" : "supplemental_income_routing",
      affectsPhysicalBalance: !same,
      sourceIncomeId: i.id,
      systemGenerated: true,
      createdAt: stamp,
      updatedAt: stamp,
    });
    const allocs = items.filter((x) => x.bucketId);
    if (allocs.length)
      await bulkPut(
        "transferAllocations",
        allocs.map((x) => ({
          id: uid("ta"),
          transferId: tid,
          bucketId: x.bucketId,
          amount: Number(x.amount || 0),
          goalId: state.goals.find((g) => g.bucketId === x.bucketId)?.id || null,
          label: x.label,
        })),
      );
  }
  modal = null;
  await load();
}

async function completeTransfer(id) {
  const t = state.transfers.find((x) => x.id === id);
  if (!t) return;
  assertPeriodEditable(t.budgetPeriodId || null);
  const stamp = new Date().toISOString();
  await put("transfers", { ...t, status: "completed", completedDate: today(), completedAt: stamp, updatedAt: stamp });
  pendingHighlight = `transfer:${t.id}`;
  modal = null;
  await load();
  toast("Transfer completed", "good");
}
async function completePaydayTransfer(periodId, accountId) {
  assertPeriodEditable(periodId);
  const req = paydayRequirements(periodId),
    group = req.groups.find((g) => g.accountId === accountId);
  if (!group || group.amount <= 0.5) {
    modal = null;
    await load();
    return;
  }
  const stamp = new Date().toISOString(),
    tid = uid("tr"),
    date = today();
  await put("transfers", {
    id: tid,
    fromAccountId: "ctbc",
    toAccountId: accountId,
    amount: group.amount,
    budgetPeriodId: periodId,
    status: "completed",
    plannedDate: date,
    completedDate: date,
    completedAt: stamp,
    transferType: accountId === "ibkr" ? "investment_contribution" : "payday",
    systemGenerated: true,
    createdAt: stamp,
    updatedAt: stamp,
  });
  const allocs = group.items.filter((x) => x.bucketId);
  if (allocs.length)
    await bulkPut(
      "transferAllocations",
      allocs.map((x) => ({
        id: uid("ta"),
        transferId: tid,
        bucketId: x.bucketId,
        amount: x.remaining,
        goalId: null,
        label: x.label,
      })),
    );
  modal = null;
  await load();
  toast("Payday transfer recorded", "good");
}
async function createSweep() {
  const p = currentPeriod();
  if (!p) return;
  assertPeriodEditable(p.id);
  const sweep = sweepInfo(p.id);
  if (sweep.available <= 0.5) return;
  const allocs = allocateGoalSurplus({
    amount: sweep.available,
    goals: state.goals,
    bucketBalances: state.bucketBalances,
  });
  const bucketAllocs = allocs.filter((a) => a.bucketId),
    investmentAmount = allocs.filter((a) => a.accountId === "ibkr").reduce((sum, a) => sum + Number(a.amount || 0), 0),
    ids = [];
  const esunAmount = bucketAllocs.reduce((sum, a) => sum + Number(a.amount || 0), 0);
  if (esunAmount > 0) {
    const tid = uid("tr");
    ids.push(tid);
    await put("transfers", {
      id: tid,
      fromAccountId: "ctbc",
      toAccountId: "esun",
      amount: esunAmount,
      budgetPeriodId: p.id,
      status: "planned",
      plannedDate: today(),
      transferType: "month_end_sweep",
      createdAt: new Date().toISOString(),
    });
    await bulkPut(
      "transferAllocations",
      bucketAllocs.map((a) => ({
        id: uid("ta"),
        transferId: tid,
        bucketId: a.bucketId,
        amount: a.amount,
        goalId: a.goalId || null,
        label: a.label,
      })),
    );
  }
  if (investmentAmount > 0) {
    const tid = uid("tr");
    ids.push(tid);
    await put("transfers", {
      id: tid,
      fromAccountId: "ctbc",
      toAccountId: "ibkr",
      amount: investmentAmount,
      budgetPeriodId: p.id,
      status: "planned",
      plannedDate: today(),
      transferType: "month_end_sweep",
      createdAt: new Date().toISOString(),
    });
  }
  modal = ids.length ? { type: "transfer", id: ids[0] } : null;
  await load();
}
async function closePeriod() {
  const p = currentPeriod();
  if (!p) return;
  if (p.state === "closed") return;
  const c = monthCloseStatus(p.id);
  if (c.hardBlockers.length) throw new Error(`Month cannot close yet: ${c.hardBlockers.join("; ")}.`);
  if (
    c.missingFixed.length &&
    !(await askConfirm(
      "Close the month anyway?",
      `${c.missingFixed.length} fixed obligation${c.missingFixed.length === 1 ? " has" : "s have"} no payment recorded.`,
      { ok: "Close month" },
    ))
  )
    return;
  // For the summary: where the Emergency Fund stood when this month began.
  const prevClose = [...state.monthlyCloses]
      .filter((x) => String(x.id) < p.id && Number.isFinite(Number(x.endingEmergency)))
      .sort((a, b) => String(b.id).localeCompare(String(a.id)))[0],
    emergencyFrom = prevClose
      ? Number(prevClose.endingEmergency)
      : Number(state.bucketBalances.emergency || 0) - completedAllocationToBucket(p.id, "emergency");
  const stamp = new Date().toISOString(),
    allIncome = state.incomes
      .filter((i) => i.budgetPeriodId === p.id && !i.deletedAt)
      .reduce((sum, i) => sum + Number(i.amount || 0), 0),
    regularIncome = periodRegularIncome(p.id),
    health = dataHealthReport();
  await put("periods", { ...p, state: "closed", closedAt: stamp, updatedAt: stamp, sweepRules: c.sweep.rules });
  await put("monthlyCloses", {
    id: p.id,
    budgetPeriodId: p.id,
    status: "closed",
    closedAt: stamp,
    snapshotVersion: 1,
    snapshotDate: today(),
    income: regularIncome,
    totalIncome: allIncome,
    eligibleIncome: periodEligibleIncome(p.id),
    expenses: totalExpenses(p.id),
    wealthContribution: completedCoreWealth(p.id),
    contributionRate: regularIncome > 0 ? completedCoreWealth(p.id) / regularIncome : 0,
    goalFunding: completedGoalFunding(p.id),
    titheAllocated: completedTithe(p.id),
    sweepAmount: c.sweep.alreadySwept,
    sweepRules: c.sweep.rules,
    sweepBillSavings: c.sweep.billSavings,
    sweepBillOverages: c.sweep.billOverages,
    sweepPaydayOverSent: c.sweep.paydayOverSent,
    endingCoreWealth: state.wealth.coreWealth,
    endingFinancialNetWorth: state.wealth.financialNetWorth,
    endingAccountBalances: {
      ctbc: c.ct.actual,
      esun: c.es.actual,
      cash: accountSnapshot("cash").actual,
      ibkrTwd: latestInvestmentTwd(),
    },
    endingBucketBalances: { ...state.bucketBalances },
    endingEmergency: Number(state.bucketBalances.emergency || 0),
    endingTithe: Number(state.bucketBalances.tithe || 0),
    endingHomeTravel: Number(state.bucketBalances["home-trip"] || 0),
    endingElectricity: Number(state.bucketBalances.electricity || 0),
    fxRate: Number(state.settings.usdTwdRate || 0),
    dataHealthSummary: { critical: health.critical, warn: health.warn, info: health.info },
    planSnapshot: c.plan,
    categoryActuals: c.totals,
    ctbcActual: c.ct.actual,
    esunActual: c.es.actual,
    missingFixedIds: c.missingFixed.map((x) => x.id),
  });
  modal = { type: "month-summary", periodId: p.id, emergencyFrom };
  await load();
}
async function reopenPeriod(periodId) {
  const p = state.periods.find((x) => x.id === periodId);
  if (!p || p.state !== "closed") return;
  const stamp = new Date().toISOString();
  await put("periods", { ...p, state: "reopened", reopenedAt: stamp, updatedAt: stamp });
  const rec = state.monthlyCloses.find((x) => x.budgetPeriodId === periodId || x.id === periodId);
  if (rec) await put("monthlyCloses", { ...rec, status: "reopened", reopenedAt: stamp });
  selectedPeriodId = periodId;
  modal = null;
  await load();
}
async function saveGoal(form) {
  const fd = new FormData(form),
    g = goal(form.dataset.goal);
  if (!g) throw new Error("Goal not found.");
  const targetAmount = Number(fd.get("targetAmount"));
  if (targetAmount + 0.5 < goalBal(g))
    throw new Error(`Target cannot be lower than the current ${g.name} balance of ${money(goalBal(g))}.`);
  const requiredThreshold = Math.max(
    0,
    ...state.goals.filter((x) => x.prerequisiteGoalId === g.id).map((x) => Number(x.prerequisiteAmount || 0)),
  );
  if (targetAmount + 0.5 < requiredThreshold)
    throw new Error(
      `${g.name} cannot be set below ${money(requiredThreshold)} because another goal unlocks at that threshold.`,
    );
  await put("goals", {
    ...g,
    targetAmount,
    targetDate: fd.get("targetDate") || null,
    monthlyTarget: Number(fd.get("monthlyTarget") || 0) || null,
    status: fd.get("status"),
    updatedAt: new Date().toISOString(),
  });
  modal = null;
  await load();
}
async function saveGoalContribution(form) {
  const fd = new FormData(form),
    g = goal(form.dataset.goal);
  if (!g) throw new Error("Goal not found.");
  const b = bucket(g.bucketId);
  if (!b) throw new Error("Goal bucket not found.");
  const amount = Number(fd.get("amount"));
  if (amount <= 0) throw new Error("Enter a contribution amount.");
  const remaining = Math.max(0, Number(g.targetAmount || 0) - goalBal(g));
  if (remaining > 0 && amount > remaining + 0.5)
    throw new Error(`This contribution exceeds the remaining ${money(remaining)} needed for ${g.name}.`);
  const periodId = fd.get("period") || null;
  assertPeriodEditable(periodId);
  const status = fd.get("completed") === "on" ? "completed" : "planned";
  if (status === "planned" && !periodId)
    throw new Error("Choose an open funding month for a planned contribution, or mark the transfer completed.");
  const stamp = new Date().toISOString(),
    tid = uid("tr"),
    date = fd.get("date");
  await put("transfers", {
    id: tid,
    fromAccountId: "ctbc",
    toAccountId: b.accountId,
    amount,
    budgetPeriodId: periodId,
    status,
    plannedDate: date,
    completedDate: status === "completed" ? date : null,
    completedAt: status === "completed" ? stamp : null,
    transferType: "goal_contribution",
    createdAt: stamp,
    updatedAt: stamp,
  });
  await put("transferAllocations", {
    id: uid("ta"),
    transferId: tid,
    bucketId: g.bucketId,
    amount,
    goalId: g.id,
    label: g.name,
  });
  modal = null;
  await load();
  toast(`Added ${money(amount)} to ${g.name}`, "good");
}

async function saveProject(form) {
  const fd = new FormData(form),
    id = fd.get("id") || uid("proj"),
    existing = project(id),
    stamp = new Date().toISOString(),
    title = String(fd.get("title") || "").trim(),
    type = form.dataset.type || existing?.type || "custom",
    converting = form.dataset.convert === "true";
  if (!title) throw new Error("Enter a Special Budget name.");
  if (existing && projectSettlement(id)) throw new Error("Undo the settlement before editing this Special Budget.");

  const startDate = fd.get("startDate") || null,
    endDate = fd.get("endDate") || null,
    fundingMode = fd.get("fundingMode") || "reimbursement",
    wallet = Math.max(0, Number(fd.get("tripWalletAllocatedTwd") || 0));
  if (startDate && endDate && String(endDate) < String(startDate)) throw new Error("Return/end date cannot be before the start date.");
  if (fundingMode === "trip_wallet") {
    if (!(wallet > 0)) throw new Error("Enter the amount to reserve in the Trip Wallet.");
    const existingReserve = existing?.fundingMode === "trip_wallet" ? Math.max(0, Number(existing.tripWalletAllocatedTwd || 0)) : 0,
      otherReserves = Math.max(0, activeSpecialBudgetReserve() - existingReserve),
      availableOperating = Math.max(0, Number(accountSnapshot("ctbc").actual || 0) - otherReserves);
    if (wallet > availableOperating + 0.5)
      throw new Error(`Trip Wallet allocation cannot exceed available CTBC operating cash of ${money(availableOperating)}.`);
  }

  let categoryRules = existing?.categoryRules || [];
  const obj = {
    ...(existing || {}),
    id,
    type,
    title,
    startDate,
    endDate,
    defaultCurrency: fd.get("defaultCurrency") || existing?.defaultCurrency || "EUR",
    fundingMode,
    tripWalletAllocatedTwd: fundingMode === "trip_wallet" ? wallet : 0,
    tripWalletSourceAccountId: fundingMode === "trip_wallet" ? "ctbc" : null,
    status: "active",
    createdAt: existing?.createdAt || stamp,
    updatedAt: stamp,
  };

  if (type === "business_trip") {
    const destination = String(fd.get("destination") || "").trim(),
      purpose = String(fd.get("purpose") || "").trim(),
      dailyAllowanceTwd = Number(fd.get("dailyAllowanceTwd")),
      defaultCurrency = String(fd.get("defaultCurrency") || ""),
      mainPaymentMethod = String(fd.get("mainPaymentMethod") || ""),
      reimbursementAccountId = String(fd.get("reimbursementAccountId") || "");
    if (!destination) throw new Error("Enter the trip destination.");
    if (!purpose) throw new Error("Enter the business purpose.");
    if (!startDate || !endDate) throw new Error("Enter both departure and return dates.");
    if (!(allowanceDays(startDate, endDate) > 0)) throw new Error("Enter a valid trip date range.");
    if (!(dailyAllowanceTwd > 0)) throw new Error("Enter the daily allowance.");
    if (!defaultCurrency) throw new Error("Select the default trip currency.");
    if (!mainPaymentMethod) throw new Error("Select the main payment method.");
    if (!reimbursementAccountId) throw new Error("Select where reimbursement will be received.");
    categoryRules = businessTripCategoryRules();
    Object.assign(obj, {
      destination,
      purpose,
      dailyAllowanceTwd,
      allowanceRule: "departure_return_combined",
      categoryRules,
      defaultCurrency,
      mainPaymentMethod,
      reimbursementAccountId,
    });
  } else {
    categoryRules = parseCustomCategoryRules({
      exact: fd.get("exactCategories"),
      flexible: fd.get("flexibleCategories"),
      tracking: fd.get("trackingCategories"),
    });
    if (!categoryRules.length) {
      categoryRules = PROJECT_CATEGORIES.map((name) => ({
        id: String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        name,
        treatment: "tracking",
      }));
    }
    Object.assign(obj, {
      categoryRules,
      flexibleCapTwd: Math.max(0, Number(fd.get("flexibleCapTwd") || 0)),
      destination: null,
      purpose: null,
      dailyAllowanceTwd: null,
      allowanceRule: null,
      mainPaymentMethod: existing?.mainPaymentMethod || "esun_card",
      reimbursementAccountId: existing?.reimbursementAccountId || "ctbc",
    });
  }

  await put("projects", obj);

  if (converting && type === "business_trip") {
    for (const old of state.projectExpenses.filter((x) => x.projectId === id && !x.deletedAt)) {
      const mapped = mapLegacyBusinessExpense(old);
      await put("projectExpenses", {
        ...old,
        ...mapped,
        updatedAt: stamp,
      });
    }
  }

  modal = { type: "project-detail", id };
  await load();
  toast(converting ? "Converted to Business Trip" : existing ? "Special Budget updated" : "Special Budget created", "good");
}

async function saveProjectExpense(form) {
  const fd = new FormData(form),
    projectId = form.dataset.project,
    p = project(projectId);
  if (!p) throw new Error("Special Budget not found.");
  if (projectSettlement(projectId)) throw new Error("Undo the settlement before editing Special Budget entries.");

  const originalAmount = Number(fd.get("originalAmount")),
    currency = fd.get("currency") || p.defaultCurrency || "EUR",
    rules = projectCategoryRules(p),
    categoryId = String(fd.get("categoryId") || ""),
    rule = rules.find((x) => x.id === categoryId) || rules[0],
    recordType = fd.get("recordType") === "refundable_deposit" ? "refundable_deposit" : "expense";
  if (!(originalAmount > 0)) throw new Error("Enter an amount greater than zero.");
  if (!rule) throw new Error("Select an expense category.");

  let raw = String(fd.get("twdAmount") ?? "").trim(),
    twdAmount = raw === "" ? null : Number(raw);
  if (currency === "TWD" && (twdAmount === null || !Number.isFinite(twdAmount))) twdAmount = originalAmount;
  if (twdAmount !== null && (!(twdAmount > 0) || !Number.isFinite(twdAmount)))
    throw new Error("Enter a valid exact NTD amount or leave it blank while traveling.");

  const id = fd.get("id") || uid("pexp"),
    old = state.projectExpenses.find((x) => x.id === id),
    stamp = new Date().toISOString(),
    wasDeposit = isRefundableDeposit(old);
  const obj = {
    ...(old || {}),
    id,
    projectId,
    date: fd.get("date") || today(),
    categoryId: rule.id,
    category: rule.name,
    reimbursementType: rule.treatment,
    recordType,
    description: String(fd.get("description") || "").trim(),
    originalAmount,
    currency,
    twdAmount,
    paymentMethod: fd.get("paymentMethod") || p.mainPaymentMethod || "esun_card",
    createdAt: old?.createdAt || stamp,
    updatedAt: stamp,
  };
  if (recordType === "refundable_deposit") {
    if (!wasDeposit) {
      obj.depositStatus = "pending";
      obj.retainedTwd = null;
      obj.retainedOriginalAmount = null;
    }
  } else {
    obj.depositStatus = null;
    obj.retainedTwd = null;
    obj.retainedOriginalAmount = null;
  }
  await put("projectExpenses", obj);
  modal = { type: "project-detail", id: projectId };
  await load();
}

async function saveProjectDeposit(form) {
  const fd = new FormData(form),
    projectId = form.dataset.project,
    id = form.dataset.id,
    p = project(projectId),
    x = state.projectExpenses.find((row) => row.id === id && !row.deletedAt);
  if (!p || !x || !isRefundableDeposit(x)) throw new Error("Refundable deposit not found.");
  if (projectSettlement(projectId)) throw new Error("Undo the settlement before changing deposit status.");

  const status = String(fd.get("depositStatus") || "pending"),
    rules = projectCategoryRules(p),
    rule = rules.find((r) => r.id === fd.get("categoryId")) || categoryRuleFor(p, x),
    stamp = new Date().toISOString();
  let retainedTwd = null,
    retainedOriginalAmount = null;
  if (["partial", "retained"].includes(status)) {
    retainedTwd = Number(fd.get("retainedTwd"));
    if (!(retainedTwd > 0) || !Number.isFinite(retainedTwd))
      throw new Error("Enter the NTD amount that was retained.");
    if (Number(x.twdAmount) > 0 && retainedTwd > Number(x.twdAmount) + 0.5)
      throw new Error("The retained amount cannot exceed the original deposit hold.");
    if (!rule) throw new Error("Choose how the retained amount should be classified.");
    retainedOriginalAmount =
      Number(x.twdAmount) > 0
        ? Number(x.originalAmount || 0) * (retainedTwd / Number(x.twdAmount))
        : x.currency === "TWD"
          ? retainedTwd
          : null;
  }
  await put("projectExpenses", {
    ...x,
    depositStatus: status,
    retainedTwd: status === "refunded" || status === "pending" ? null : retainedTwd,
    retainedOriginalAmount: status === "refunded" || status === "pending" ? null : retainedOriginalAmount,
    ...(rule && ["partial", "retained"].includes(status)
      ? { categoryId: rule.id, category: rule.name, reimbursementType: rule.treatment }
      : {}),
    depositResolvedAt: ["refunded", "partial", "retained"].includes(status) ? stamp : null,
    updatedAt: stamp,
  });
  modal = { type: "project-detail", id: projectId };
  await load();
  toast(status === "refunded" ? "Deposit marked refunded" : status === "pending" ? "Deposit remains pending" : "Deposit outcome saved", "good");
}

async function deleteProjectExpense(projectId, id) {
  if (projectSettlement(projectId)) throw new Error("Undo the settlement before deleting project expenses.");
  const x = state.projectExpenses.find((e) => e.id === id && !e.deletedAt);
  if (!x) return;
  await put("projectExpenses", { ...x, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  modal = { type: "project-detail", id: projectId };
  await load();
}
function projectRouteTarget(strategy) {
  if (strategy === "invest") return { accountId: "ibkr", bucketId: null, label: "Investments" };
  if (strategy === "keep") return null;
  const b = bucket(strategy);
  if (!b) throw new Error("Selected surplus destination is unavailable.");
  return { accountId: b.accountId, bucketId: b.id, label: b.name };
}
async function saveProjectSettlement(form) {
  const fd = new FormData(form),
    projectId = form.dataset.project,
    p = project(projectId);
  if (!p) throw new Error("Special Budget not found.");
  if (projectSettlement(projectId)) throw new Error("Special Budget is already settled.");

  const expenses = projectExpenses(projectId),
    pendingDeposits = unresolvedDeposits(expenses),
    missing = projectMissingTwd(projectId);
  if (pendingDeposits.length)
    throw new Error(`${pendingDeposits.length} refundable deposit${pendingDeposits.length === 1 ? " is" : "s are"} still unresolved.`);
  if (missing.length)
    throw new Error(
      `${missing.length} project expense${missing.length === 1 ? " still needs" : "s still need"} an exact NTD amount.`,
    );

  const total = Math.round(projectKnownTwd(projectId)),
    reimbursement = Math.round(Number(fd.get("reimbursementTwd")));
  if (!Number.isFinite(reimbursement) || reimbursement < 0) throw new Error("Enter a valid reimbursement amount.");

  const summary = projectBudgetSummary(p, expenses, today()),
    expectedReimbursement = p.type === "business_trip" ? Math.round(summary.expectedReimbursement) : null,
    diff = reimbursement - total,
    route = fd.get("surplusRoute") || "keep",
    stamp = new Date().toISOString(),
    date = fd.get("date") || today(),
    periodId = entryPeriodId(),
    cardPaid = Math.round(projectPaymentTwd(projectId, "esun_card")),
    reimbursementAccountId = p.reimbursementAccountId || "ctbc";
  if (periodId) assertPeriodEditable(periodId);

  const settlementId = uid("pset");
  let generatedIncomeId = null,
    generatedExpenseId = null,
    generatedTransferId = null;

  if (diff > 0.5) {
    generatedIncomeId = uid("inc");
    await put("incomes", {
      id: generatedIncomeId,
      dateReceived: date,
      budgetPeriodId: periodId,
      amount: diff,
      incomeType: "project_surplus",
      accountId: reimbursementAccountId,
      description: `${p.title} settlement surplus`,
      titheEligible: false,
      includedInRegularIncomeMetrics: false,
      routingHandled: true,
      sourceProjectId: projectId,
      systemGenerated: true,
      createdAt: stamp,
    });
    const target = projectRouteTarget(route);
    if (target) {
      generatedTransferId = uid("tr");
      const sameAccount = reimbursementAccountId === target.accountId;
      await put("transfers", {
        id: generatedTransferId,
        fromAccountId: reimbursementAccountId,
        toAccountId: target.accountId,
        amount: diff,
        budgetPeriodId: periodId,
        status: sameAccount ? "completed" : "planned",
        plannedDate: date,
        completedDate: sameAccount ? date : null,
        completedAt: sameAccount ? stamp : null,
        transferType: sameAccount ? "purpose_reallocation" : "project_surplus_routing",
        affectsPhysicalBalance: !sameAccount,
        sourceProjectId: projectId,
        systemGenerated: true,
        createdAt: stamp,
        updatedAt: stamp,
      });
      if (target.bucketId)
        await put("transferAllocations", {
          id: uid("ta"),
          transferId: generatedTransferId,
          bucketId: target.bucketId,
          amount: diff,
          goalId: state.goals.find((g) => g.bucketId === target.bucketId)?.id || null,
          label: target.label,
        });
    }
  } else if (diff < -0.5) {
    generatedExpenseId = uid("exp");
    await put("expenses", {
      id: generatedExpenseId,
      date,
      budgetPeriodId: periodId,
      amount: Math.abs(diff),
      categoryId: "project-shortfall",
      accountId: reimbursementAccountId,
      fundingBucketId: null,
      description: `${p.title} personal shortfall`,
      sourceProjectId: projectId,
      excludeFromBudget: true,
      systemGenerated: true,
      createdAt: stamp,
      updatedAt: stamp,
    });
  }

  await put("projectSettlements", {
    id: settlementId,
    projectId,
    reimbursementTwd: reimbursement,
    expectedReimbursementTwd: expectedReimbursement,
    reimbursementDate: date,
    reimbursementAccountId,
    totalProjectCostTwd: total,
    exactReimbursableTwd: p.type === "business_trip" ? Math.round(summary.exact) : null,
    flexibleAllowanceTwd: p.type === "business_trip" ? Math.round(summary.allowance) : null,
    flexibleSpentTwd: p.type === "business_trip" ? Math.round(summary.flexible) : null,
    differenceTwd: diff,
    cardPaidTwd: cardPaid,
    cashOtherTwd: Math.max(0, total - cardPaid),
    surplusRoute: route,
    generatedIncomeId,
    generatedExpenseId,
    generatedTransferId,
    cardClearingConfirmed: cardPaid <= 0.5,
    createdAt: stamp,
    updatedAt: stamp,
  });
  await put("projects", { ...p, status: "settled", settledAt: stamp, updatedAt: stamp });
  modal = { type: "project-detail", id: projectId };
  await load();
  toast("Special Budget settled", "good");
}
async function confirmProjectCardClearing(projectId) {
  const st = projectSettlement(projectId);
  if (!st) return;
  await put("projectSettlements", {
    ...st,
    cardClearingConfirmed: true,
    cardClearingConfirmedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  modal = { type: "project-detail", id: projectId };
  await load();
}
async function undoProjectSettlement(projectId) {
  const p = project(projectId),
    st = projectSettlement(projectId);
  if (!p || !st) return;
  if (st.generatedTransferId) {
    const t = state.transfers.find((x) => x.id === st.generatedTransferId && !x.deletedAt);
    if (t?.status === "completed")
      throw new Error(
        "The surplus transfer is already completed. Reverse that real bank movement manually before undoing the settlement.",
      );
    if (t) {
      for (const a of state.transferAllocations.filter((a) => a.transferId === t.id))
        await remove("transferAllocations", a.id);
      await remove("transfers", t.id);
    }
  }
  if (st.generatedIncomeId) await remove("incomes", st.generatedIncomeId);
  if (st.generatedExpenseId) await remove("expenses", st.generatedExpenseId);
  await remove("projectSettlements", st.id);
  await put("projects", { ...p, status: "active", settledAt: null, updatedAt: new Date().toISOString() });
  modal = { type: "project-detail", id: projectId };
  await load();
}
function exportProjectCsv(projectId) {
  const p = project(projectId);
  if (!p) return;
  const rows = [[
    "Date",
    "Category",
    "Treatment",
    "Entry Type",
    "Description",
    "Original Amount",
    "Currency",
    "NTD Amount",
    "Payment Method",
    "Deposit Status",
    "Retained NTD",
  ]];
  for (const x of projectExpenses(projectId))
    rows.push([
      x.date,
      x.category,
      x.reimbursementType || categoryRuleFor(p, x)?.treatment || "tracking",
      x.recordType || "expense",
      x.description || "",
      x.originalAmount,
      x.currency,
      x.twdAmount ?? "",
      x.paymentMethod,
      x.depositStatus || "",
      x.retainedTwd ?? "",
    ]);
  downloadText(
    `${
      (p.title || "special-budget")
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase() || "special-budget"
    }-${today()}.csv`,
    rows.map((r) => r.map(csvCell).join(",")).join("\n"),
  );
}
async function saveCashTransfer(form) {
  const fd = new FormData(form),
    mode = form.dataset.mode || "withdrawal",
    amount = Number(fd.get("amount")),
    date = fd.get("date") || today(),
    periodId = fd.get("period") || null;
  if (amount <= 0) throw new Error("Enter a cash amount greater than zero.");
  assertPeriodEditable(periodId);
  const cashBal = Number(accountSnapshot("cash").actual || 0),
    ctBal = Number(accountSnapshot("ctbc").actual || 0);
  if (mode === "deposit" && amount > cashBal + 0.5)
    throw new Error(`Cash deposit cannot exceed your tracked Cash Wallet balance of ${money(cashBal)}.`);
  if (mode === "withdrawal" && amount > ctBal + 0.5)
    throw new Error(`Cash withdrawal exceeds your tracked CTBC balance of ${money(ctBal)}.`);
  const stamp = new Date().toISOString(),
    from = mode === "deposit" ? "cash" : "ctbc",
    to = mode === "deposit" ? "ctbc" : "cash";
  await put("transfers", {
    id: uid("tr"),
    fromAccountId: from,
    toAccountId: to,
    amount,
    budgetPeriodId: periodId,
    status: "completed",
    plannedDate: date,
    completedDate: date,
    completedAt: stamp,
    transferType: mode === "deposit" ? "cash_deposit" : "cash_withdrawal",
    affectsPhysicalBalance: true,
    systemGenerated: false,
    createdAt: stamp,
    updatedAt: stamp,
  });
  modal = null;
  await load();
  toast(`${mode === "deposit" ? "Cash deposit" : "Cash withdrawal"} saved · ${money(amount)}`);
}

async function saveInvestment(form) {
  const fd = new FormData(form);
  const fx = Number(fd.get("fx"));
  await put("investmentSnapshots", {
    id: uid("snap"),
    accountId: "ibkr",
    date: fd.get("date"),
    value: Number(fd.get("value")),
    currency: "USD",
    fxRate: fx,
    createdAt: new Date().toISOString(),
  });
  await put("settings", { ...state.settings, usdTwdRate: fx, updatedAt: new Date().toISOString() });
  modal = null;
  await load();
}
function prepareAccountReconciliation(form) {
  const fd = new FormData(form),
    accountId = form.dataset.account,
    actualBalance = Number(fd.get("actualBalance"));
  if (!Number.isFinite(actualBalance) || actualBalance < 0) throw new Error("Enter a valid non-negative bank balance.");
  modal = {
    type: "reconcile-preview",
    draft: { accountId, actualBalance, date: fd.get("date") || today(), note: fd.get("note") || "" },
  };
  render();
}
async function confirmAccountReconciliation() {
  const d = modal?.draft;
  if (!d) throw new Error("Balance preview is no longer available.");
  const snap = d.accountId === "esun" ? esunSnapshot() : accountSnapshot(d.accountId),
    expected = Number(snap.actual || 0),
    stamp = new Date().toISOString();
  await put("reconciliations", {
    id: uid("rec"),
    accountId: d.accountId,
    date: d.date,
    actualBalance: Number(d.actualBalance),
    expectedBalance: expected,
    difference: Number(d.actualBalance) - expected,
    note: d.note || "",
    createdAt: stamp,
    appVersion: APP_VERSION,
  });
  if (d.accountId === "esun") {
    const virtualTotal = state.buckets
      .filter((b) => b.accountId === "esun")
      .reduce((sum, b) => sum + Number(state.bucketBalances[b.id] || 0), 0);
    const unassigned = Number(d.actualBalance) - virtualTotal;
    if (Math.abs(unassigned) >= 0.5) {
      modal = { type: "esun-allocate", amount: unassigned };
      await load();
      return;
    }
  }
  modal = null;
  await load();
}

async function saveAccountAdjustment(form) {
  const fd = new FormData(form),
    accountId = form.dataset.account,
    amount = Number(fd.get("amount"));
  if (!amount) throw new Error("Enter a non-zero adjustment amount.");
  await put("adjustments", {
    id: uid("adj"),
    accountId,
    amount,
    date: fd.get("date"),
    note: fd.get("note") || "",
    createdAt: new Date().toISOString(),
  });
  modal = null;
  await load();
}
async function saveEsunAllocation(form) {
  const fd = new FormData(form),
    limit = Number(fd.get("limit") || 0),
    direction = Number(fd.get("direction") || 1);
  const allocations = [];
  for (const b of state.buckets.filter((b) => b.accountId === "esun")) {
    const v = Number(fd.get(`bucket-${b.id}`) || 0);
    if (v > 0)
      allocations.push({
        bucketId: b.id,
        amount: v * direction,
        label: direction > 0 ? "Purpose allocation" : "Purpose reduction",
      });
  }
  const total = allocations.reduce((s, a) => s + Math.abs(Number(a.amount)), 0);
  if (total <= 0) throw new Error("Enter at least one allocation amount.");
  if (total > limit + 0.5) throw new Error(`Allocation cannot exceed ${money(limit)}.`);
  if (direction < 0) {
    for (const a of allocations) {
      if (Math.abs(a.amount) > Number(state.bucketBalances[a.bucketId] || 0) + 0.5)
        throw new Error(`Cannot reduce ${bucket(a.bucketId)?.name} below zero.`);
    }
  }
  const tid = uid("tr");
  await put("transfers", {
    id: tid,
    fromAccountId: "esun",
    toAccountId: "esun",
    amount: total,
    budgetPeriodId: null,
    status: "completed",
    plannedDate: today(),
    completedDate: today(),
    transferType: "bucket_allocation",
    affectsPhysicalBalance: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await bulkPut(
    "transferAllocations",
    allocations.map((a) => ({
      id: uid("ta"),
      transferId: tid,
      bucketId: a.bucketId,
      amount: a.amount,
      goalId: null,
      label: a.label,
    })),
  );
  modal = null;
  await load();
}
async function saveEsunReallocation(form) {
  const fd = new FormData(form),
    fromBucket = fd.get("fromBucket"),
    toBucket = fd.get("toBucket"),
    amount = Number(fd.get("amount"));
  if (fromBucket === toBucket) throw new Error("Choose two different purpose buckets.");
  if (amount <= 0) throw new Error("Enter a reallocation amount greater than zero.");
  if (amount > Number(state.bucketBalances[fromBucket] || 0) + 0.5)
    throw new Error(
      `Cannot move more than the current ${bucket(fromBucket)?.name || "source"} balance of ${money(state.bucketBalances[fromBucket] || 0)}.`,
    );
  const stamp = new Date().toISOString(),
    tid = uid("tr"),
    date = fd.get("date") || today();
  await put("transfers", {
    id: tid,
    fromAccountId: "esun",
    toAccountId: "esun",
    amount,
    budgetPeriodId: null,
    status: "completed",
    plannedDate: date,
    completedDate: date,
    completedAt: stamp,
    transferType: "purpose_reallocation",
    affectsPhysicalBalance: false,
    note: fd.get("note") || "",
    createdAt: stamp,
    updatedAt: stamp,
  });
  await bulkPut("transferAllocations", [
    {
      id: uid("ta"),
      transferId: tid,
      bucketId: fromBucket,
      amount: -amount,
      goalId: null,
      label: `Move from ${bucket(fromBucket)?.name || fromBucket}`,
    },
    {
      id: uid("ta"),
      transferId: tid,
      bucketId: toBucket,
      amount: amount,
      goalId: null,
      label: `Move to ${bucket(toBucket)?.name || toBucket}`,
    },
  ]);
  modal = null;
  await load();
}
async function reversePurposeAllocation(transferId) {
  const t = state.transfers.find((x) => x.id === transferId && !x.deletedAt);
  if (!t) throw new Error("Allocation record not found.");
  const event = {
    transfer: t,
    allocations: allocationsForTransfer(t.id),
    reversedBy: state.transfers.find((r) => !r.deletedAt && r.reversalOf === t.id) || null,
  };
  if (!canReversePurposeEvent(event))
    throw new Error(
      "This allocation cannot be reversed here. System-generated or already-reversed records are protected.",
    );
  for (const a of event.allocations) {
    if (Number(a.amount) > 0 && Number(a.amount) > Number(state.bucketBalances[a.bucketId] || 0) + 0.5)
      throw new Error(
        `Cannot reverse ${bucket(a.bucketId)?.name || a.bucketId}; part of that allocation has already been used or moved.`,
      );
  }
  const stamp = new Date().toISOString(),
    tid = uid("tr"),
    date = today();
  await put("transfers", {
    id: tid,
    fromAccountId: t.fromAccountId,
    toAccountId: t.toAccountId,
    amount: Number(t.amount || event.allocations.reduce((sum, a) => sum + Math.abs(Number(a.amount || 0)), 0)),
    budgetPeriodId: null,
    status: "completed",
    plannedDate: date,
    completedDate: date,
    completedAt: stamp,
    transferType: "allocation_reversal",
    affectsPhysicalBalance: false,
    reversalOf: t.id,
    createdAt: stamp,
    updatedAt: stamp,
  });
  await bulkPut(
    "transferAllocations",
    event.allocations.map((a) => ({
      id: uid("ta"),
      transferId: tid,
      bucketId: a.bucketId,
      amount: -Number(a.amount || 0),
      goalId: null,
      label: `Reversal · ${a.label || bucket(a.bucketId)?.name || "allocation"}`,
    })),
  );
  modal = { type: "account-audit", accountId: t.fromAccountId };
  await load();
}

async function deleteFundingMonth(periodId) {
  const p = state.periods.find((x) => x.id === periodId);
  if (!p) throw new Error("Funding month not found.");
  if (p.state === "closed") throw new Error("Closed months cannot be deleted.");
  const transfers = state.transfers.filter((x) => x.budgetPeriodId === periodId && !x.deletedAt);
  const completed = transfers.filter(
    (x) =>
      x.status === "completed" &&
      !(x.systemGenerated && x.fromAccountId === x.toAccountId && x.transferType === "reserve_allocation"),
  );
  if (completed.length)
    throw new Error("This month has completed transfers. Resolve those before deleting the funding month.");
  for (const t of transfers) {
    for (const a of state.transferAllocations.filter((a) => a.transferId === t.id))
      await remove("transferAllocations", a.id);
    await remove("transfers", t.id);
  }
  for (const x of state.expenses.filter((x) => x.budgetPeriodId === periodId)) await remove("expenses", x.id);
  for (const x of state.incomes.filter((x) => x.budgetPeriodId === periodId)) await remove("incomes", x.id);
  for (const x of state.monthlyCloses.filter((x) => x.budgetPeriodId === periodId || x.id === periodId))
    await remove("monthlyCloses", x.id);
  await remove("periods", periodId);
  selectedPeriodId = null;
  modal = null;
  await load();
}

async function deleteTransaction(kind, id) {
  let x = null;
  if (kind === "expense") x = state.expenses.find((e) => e.id === id);
  if (kind === "income") x = state.incomes.find((e) => e.id === id);
  if (kind === "transfer") x = state.transfers.find((e) => e.id === id);
  if (!x) return;
  assertPeriodEditable(x.budgetPeriodId || null);
  if (kind === "expense") await put("expenses", { ...x, deletedAt: new Date().toISOString() });
  if (kind === "income") await put("incomes", { ...x, deletedAt: new Date().toISOString() });
  if (kind === "transfer") await put("transfers", { ...x, deletedAt: new Date().toISOString() });
  await load();
  toast(`${kind[0].toUpperCase()}${kind.slice(1)} deleted`);
}
async function saveSettings(form) {
  const fd = new FormData(form),
    stamp = new Date().toISOString(),
    applyField = form.querySelector('input[name=\"applyCurrentMonth\"]'),
    syncCurrent = !!applyField && applyField.checked,
    selected = currentPeriod();
  const updatedSettings = {
    ...state.settings,
    forecastSalary: Number(fd.get("forecastSalary")),
    usdTwdRate: Number(fd.get("usdTwdRate")),
    wealthRaisePercent: Number(fd.get("wealthRaisePercent")),
    forecastInvestmentReturn: Number(fd.get("forecastInvestmentReturn")),
    forecastSalaryGrowth: Number(fd.get("forecastSalaryGrowth")),
    conservativeInvestmentReturn: Number(fd.get("conservativeInvestmentReturn")),
    conservativeSalaryGrowth: Number(fd.get("conservativeSalaryGrowth")),
    aggressiveInvestmentReturn: Number(fd.get("aggressiveInvestmentReturn")),
    aggressiveSalaryGrowth: Number(fd.get("aggressiveSalaryGrowth")),
    applyBudgetChangesToCurrentMonth: applyField
      ? syncCurrent
      : state.settings.applyBudgetChangesToCurrentMonth !== false,
    appVersion: APP_VERSION,
    dataModelVersion: DATA_MODEL_VERSION,
    updatedAt: stamp,
  };
  const updatedCategories = [];
  for (const c of state.categories) {
    const v = fd.get(`cat-${c.id}`);
    updatedCategories.push(v !== null ? { ...c, defaultAmount: Number(v), updatedAt: stamp } : c);
  }
  const ob = fd.get("cat-operating-buffer");
  if (ob !== null) updatedSettings.operatingBuffer = Number(ob);
  else
    updatedSettings.operatingBuffer = Number(
      updatedCategories.find((c) => c.id === "operating-buffer")?.defaultAmount || 3000,
    );
  await put("settings", updatedSettings);
  for (const c of updatedCategories) await put("categories", c);

  // Optional current-month sync updates only the open month's plan snapshot. It never edits
  // transactions, completed transfers, allocations or any closed-month snapshot.
  if (syncCurrent && selected && selected.state !== "closed")
    await syncOpenMonthPlan(selected, updatedCategories, updatedSettings, stamp);
  modal = null;
  await load();
  toast("Settings saved");
}
// Refresh an open month's budget plan after budget rules change. Never edits transactions,
// completed transfers, allocations or any closed-month snapshot.
async function syncOpenMonthPlan(selected, categories, settings, stamp, goals = state.goals) {
  const salary = periodRegularIncome(selected.id),
    newPlan = buildBudgetPlan({ income: salary, categories, settings });
  const preBalances = { ...state.bucketBalances };
  for (const b of state.buckets)
    preBalances[b.id] = Number(preBalances[b.id] || 0) - completedAllocationToBucket(selected.id, b.id);
  const goalAllocs = allocateGoalSurplus({
    amount: Math.max(0, Math.round(newPlan.immediateWealth)),
    goals,
    bucketBalances: preBalances,
  });
  await put("periods", {
    ...selected,
    planSnapshot: newPlan,
    paydayRoutingSnapshot: { goalAllocs: goalAllocs.map((a) => ({ ...a })), createdAt: stamp, reason: "budget_sync" },
    budgetRulesUpdatedAt: stamp,
    budgetRevision: Number(selected.budgetRevision || 0) + 1,
    updatedAt: stamp,
  });
}
async function backup() {
  const data = await exportData(),
    name = `wealth-os-backup-${today()}.json`,
    text = JSON.stringify(data, null, 2);
  const done = async () => {
    await put("settings", { ...state.settings, lastBackupAt: new Date().toISOString(), backupSnoozeUntil: null });
    await load();
  };
  // On a phone the share sheet ("Save to Files") is more reliable than a download inside a home-screen app.
  try {
    const file = new File([text], name, { type: "application/json" });
    if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "Wealth OS backup" });
      return done();
    }
  } catch (err) {
    if (err?.name === "AbortError") return; // cancelled: don't record a backup that didn't happen
  }
  downloadText(name, text, "application/json");
  await done();
}
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function downloadText(filename, text, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportActivityCsv() {
  const rows = [
    ["Date", "Type", "Status", "Title", "Description", "Account / Ledger", "Amount (TWD)", "Funding Month"],
  ];
  for (const x of activityRecords())
    rows.push([
      x._date || "",
      x._kind,
      x.status || "completed",
      x._title || "",
      x.description || x._detail || "",
      x._account || "",
      Number(x._amount || 0),
      x.budgetPeriodId || "",
    ]);
  downloadText(`wealth-os-activity-${today()}.csv`, rows.map((r) => r.map(csvCell).join(",")).join("\n"));
}
function exportMonthlyCsv() {
  const rows = [
    [
      "Month",
      "State",
      "Regular Income",
      "Total Income",
      "Expenses",
      "Core Wealth Contribution",
      "Contribution Rate",
      "Core Wealth",
      "Financial Net Worth",
    ],
  ];
  for (const r of historyRecords())
    rows.push([
      r.id,
      r.state,
      Math.round(r.regularIncome || 0),
      Math.round(r.totalIncome || 0),
      Math.round(r.expenses || 0),
      Math.round(r.wealthContribution || 0),
      (Number(r.contributionRate || 0) * 100).toFixed(2),
      r.coreWealth === null ? "" : Math.round(r.coreWealth),
      r.financialNetWorth === null ? "" : Math.round(r.financialNetWorth),
    ]);
  downloadText(`wealth-os-monthly-summary-${today()}.csv`, rows.map((r) => r.map(csvCell).join(",")).join("\n"));
}
async function restore(file) {
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't valid JSON. Nothing was changed.");
  }
  const check = validateBackup(payload);
  if (!check.ok) throw new Error(`${check.reason} Nothing was changed.`);
  const current = await exportData(),
    now = backupSummary(current),
    next = check.summary,
    when = next.exportedAt ? new Date(next.exportedAt).toLocaleString() : "unknown date",
    line = (x) => `${x.months} month${x.months === 1 ? "" : "s"}, ${x.expenses} expenses, ${x.incomes} incomes, ${x.transfers} transfers`;
  if (
    !(await askConfirm(
      "Replace all data with this backup?",
      `This device now: ${line(now)}.\nBackup from ${when}: ${line(next)}.\n\nA copy of your current data is kept so you can undo this in Settings.`,
      { ok: "Replace my data", danger: true },
    ))
  )
    return;
  await saveUndoSnapshot(current);
  await importData(payload);
  reachedGoals = null; // a restored backup isn't "reaching" a goal
  modal = { type: "settings" };
  selectedPeriodId = null;
  await load();
  toast("Backup restored. Settings → Undo restore puts your old data back.", "good");
}
async function undoRestore() {
  const snap = await getUndoSnapshot();
  if (!snap?.payload) throw new Error("No undo copy was found.");
  if (
    !(await askConfirm(
      "Put back your previous data?",
      `The data you had before the last restore (saved ${new Date(snap.savedAt).toLocaleString()}) comes back, and the restored data is replaced.`,
      { ok: "Put it back" },
    ))
  )
    return;
  await importData(snap.payload);
  await clearUndoSnapshot();
  reachedGoals = null;
  selectedPeriodId = null;
  await load();
  toast("Previous data is back.", "good");
}
function runScenario() {
  const salary = Number(document.querySelector("#scenario-salary").value || 0),
    annual = Number(document.querySelector("#scenario-return").value || 0),
    growth = Number(document.querySelector("#scenario-growth").value || 0),
    extra = Number(document.querySelector("#scenario-extra").value || 0);
  const result = scenarioFor(annual, growth, extra, salary),
    sim = result.sim;
  document.querySelector("#scenario-result").innerHTML =
    `<div class="notice"><strong>${money(result.monthly)}/month</strong> starting modeled wealth capacity.<br>Salary growth: <strong>${growth.toFixed(1)}%</strong> · Investment return: <strong>${annual.toFixed(1)}%</strong><br>Emergency target: <strong>${formatMonths(sim.events.emergencyCompleteMonth)}</strong><br>${money(1000000)}: <strong>${formatMonths(sim.hits[1000000])}</strong> · ${money(5000000)}: <strong>${formatMonths(sim.hits[5000000])}</strong> · ${money(10000000)}: <strong>${formatMonths(sim.hits[10000000])}</strong><br><span class="sub">${Number(state.settings.wealthRaisePercent || 75)}% of modeled salary raises is added to wealth capacity. Investment return applies only to investments.</span></div>`;
}

function bind() {
  document.querySelectorAll("[data-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        tab = b.dataset.tab;
        render();
      }),
  );
  const ps = document.querySelector("#period-select");
  if (ps)
    ps.onchange = () => {
      selectedPeriodId = ps.value;
      render();
    };
  document.querySelectorAll("[data-action]").forEach(
    (b) =>
      (b.onclick = async () => {
        const a = b.dataset.action;
        try {
          if (a === "new-paycheck") {
            if (!paycheckWindow().open) return;
            modal = { type: "paycheck" };
          }
          if (a === "add-expense") modal = { type: "expense", periodId: entryPeriodId() };
          if (a === "new-entry") modal = { type: "new-entry", kind: "expense", periodId: entryPeriodId() };
          if (a === "entry-kind" && modal?.type === "new-entry") modal = { ...modal, kind: b.dataset.kind };
          if (a === "add-income") modal = { type: "income" };
          if (a === "route-income") modal = { type: "income-routing", incomeId: b.dataset.id };
          if (a === "skip-income-routing") {
            modal = null;
            return render();
          }
          if (a === "manual-transfer") modal = { type: "manual-transfer" };
          if (a === "cash-withdraw") modal = { type: "cash-transfer", mode: "withdrawal" };
          if (a === "cash-deposit") modal = { type: "cash-transfer", mode: "deposit" };
          if (a === "open-projects") modal = { type: "projects-list" };
          if (a === "new-project") modal = { type: "project-type" };
          if (a === "new-business-trip") modal = { type: "project-form", budgetType: "business_trip" };
          if (a === "new-custom-budget") modal = { type: "project-form", budgetType: "custom" };
          if (a === "edit-project") modal = { type: "project-form", id: b.dataset.id };
          if (a === "convert-project-business") modal = { type: "project-convert-business", id: b.dataset.id };
          if (a === "open-project") modal = { type: "project-detail", id: b.dataset.id };
          if (a === "add-project-expense") modal = { type: "project-expense", projectId: b.dataset.project };
          if (a === "edit-project-expense")
            modal = { type: "project-expense", projectId: b.dataset.project, expenseId: b.dataset.id };
          if (a === "resolve-project-deposit")
            modal = { type: "project-deposit", projectId: b.dataset.project, expenseId: b.dataset.id };
          if (a === "delete-project-expense") {
            if (await askConfirm("Delete this Special Budget entry?", "", { ok: "Delete", danger: true }))
              return deleteProjectExpense(b.dataset.project, b.dataset.id);
            return;
          }
          if (a === "settle-project") modal = { type: "project-settle", projectId: b.dataset.id };
          if (a === "confirm-project-card-clearing") return confirmProjectCardClearing(b.dataset.id);
          if (a === "undo-project-settlement") {
            if (
              await askConfirm("Undo this project settlement?", "Its generated personal-ledger entries are removed too.", {
                ok: "Undo settlement",
                danger: true,
              })
            )
              return undoProjectSettlement(b.dataset.id);
            return;
          }
          if (a === "export-project-csv") return exportProjectCsv(b.dataset.id);
          if (a === "set-theme") {
            const theme = b.dataset.theme;
            applyTheme(theme);
            await put("settings", { ...state.settings, theme, updatedAt: new Date().toISOString() });
            state.settings = { ...state.settings, theme };
            return render();
          }
          if (a === "privacy-toggle") {
            await put("settings", {
              ...state.settings,
              privacyMode: !state.settings.privacyMode,
              updatedAt: new Date().toISOString(),
            });
            return load();
          }
          if (a === "complete-transfer") modal = { type: "transfer", id: b.dataset.id };
          if (a === "payday-transfer")
            modal = { type: "payday-transfer", periodId: b.dataset.period, accountId: b.dataset.account };
          if (a === "confirm-payday-transfer") return completePaydayTransfer(b.dataset.period, b.dataset.account);
          if (a === "confirm-manual-transfer") return commitManualTransfer();
          if (a === "manual-transfer-back") {
            const d = modal?.draft;
            modal = { type: "manual-transfer", id: d?.id || null, draft: d };
            return render();
          }
          if (a === "confirm-reconciliation") return confirmAccountReconciliation();
          if (a === "confirm-transfer") return completeTransfer(b.dataset.id);
          if (a === "month-close") modal = { type: "close" };
          if (a === "create-sweep") return createSweep();
          if (a === "close-period") return closePeriod();
          if (a === "settings") modal = { type: "settings" };
          if (a === "manage-categories") modal = { type: "manage-categories" };
          if (a === "new-category") modal = { type: "category-form" };
          if (a === "edit-category") modal = { type: "category-form", id: b.dataset.id };
          if (a === "manage-funds") modal = { type: "manage-funds" };
          if (a === "new-fund") modal = { type: "fund-form" };
          if (a === "edit-fund") modal = { type: "fund-form", id: b.dataset.id };
          if (a === "data-health") modal = { type: "data-health" };
          if (a === "period-step" && b.dataset.id) {
            selectedPeriodId = b.dataset.id;
            return render();
          }
          if (a === "investment-snapshot") modal = { type: "investment" };
          if (a === "account-reconcile") modal = { type: "account-reconcile", accountId: b.dataset.id };
          if (a === "account-audit") modal = { type: "account-audit", accountId: b.dataset.id };
          if (a === "esun-reallocate") modal = { type: "esun-reallocate" };
          if (a === "account-adjustment") modal = { type: "account-adjustment", accountId: b.dataset.id };
          if (a === "esun-allocate") modal = { type: "esun-allocate", amount: esunSnapshot().unassigned };
          if (a === "delete-period") modal = { type: "delete-period", periodId: b.dataset.id };
          if (a === "account-actions") modal = { type: "account-actions", accountId: b.dataset.id };
          if (a === "month-actions") modal = { type: "month-actions", periodId: b.dataset.id };
          if (a === "reopen-period") return reopenPeriod(b.dataset.id || currentPeriod()?.id);
          if (a === "edit-goal") modal = { type: "edit-goal", goalId: b.dataset.id };
          if (a === "goal-contribution") modal = { type: "goal-contribution", goalId: b.dataset.id };
          if (a === "confirm-delete-period") {
            if (
              await askConfirm(`Delete ${monthLabel(b.dataset.id)}?`, "It's removed with all of its data. This can't be undone.", {
                ok: "Delete month",
                danger: true,
              })
            )
              return deleteFundingMonth(b.dataset.id);
            return;
          }
          if (a === "reverse-allocation") {
            if (
              await askConfirm(
                "Reverse this purpose allocation?",
                "This creates a new audit record and does not move bank cash.",
                { ok: "Reverse" },
              )
            )
              return reversePurposeAllocation(b.dataset.id);
            return;
          }
          if (a === "home-day") {
            homeDay = b.dataset.day && b.dataset.day !== homeDay ? b.dataset.day : null;
            return render();
          }
          if (a === "home-week") {
            homeWeekStart = b.dataset.start || null;
            homeDay = null;
            return render();
          }
          if (a === "activity-filter") {
            activityFilter = b.dataset.filter;
            return render();
          }
          if (a === "clear-activity-search") {
            activitySearch = "";
            return render();
          }
          if (a === "record-fixed") {
            const c = category(b.dataset.category);
            modal = {
              type: "expense",
              periodId: entryPeriodId(),
              prefill: {
                amount: Number(b.dataset.amount || 0),
                categoryId: b.dataset.category,
                accountId: "ctbc",
                description: c?.name || "Fixed obligation",
              },
            };
          }
          if (a === "repeat-expense") {
            const x = state.expenses.find((e) => e.id === b.dataset.id);
            if (x) {
              modal = {
                type: "expense",
                periodId: entryPeriodId(),
                prefill: {
                  amount: Number(x.amount || 0),
                  categoryId: x.categoryId,
                  accountId: x.accountId || "ctbc",
                  fundingBucketId: x.fundingBucketId || "",
                  description: x.description || "",
                },
              };
            }
          }
          if (a === "edit-transaction") {
            if (b.dataset.kind === "expense") modal = { type: "expense", id: b.dataset.id };
            if (b.dataset.kind === "income") modal = { type: "income", id: b.dataset.id };
            if (b.dataset.kind === "transfer") modal = { type: "manual-transfer", id: b.dataset.id };
          }
          if (a === "row-actions") modal = { type: "row-actions", kind: b.dataset.kind, id: b.dataset.id };
          if (a === "delete-transaction") {
            if (await askConfirm(`Delete this ${b.dataset.kind}?`, "", { ok: "Delete", danger: true })) {
              if (modal?.type === "row-actions") modal = null;
              return deleteTransaction(b.dataset.kind, b.dataset.id);
            }
            return;
          }
          if (a === "close-modal") modal = null;
          if (a === "backdrop-close") {
            // Tapping outside a pop-up closes it, but never silently discards what you typed.
            if (
              modalDirty &&
              !(await askConfirm("Discard what you've entered?", "", { ok: "Discard", cancel: "Keep editing", danger: true }))
            )
              return;
            modal = null;
          }
          if (a === "export-backup") return backup();
          if (a === "undo-restore") return undoRestore();
          if (a === "discard-undo") {
            if (
              await askConfirm("Delete the undo copy?", "You won't be able to undo the last restore.", { ok: "Delete", danger: true })
            ) {
              await clearUndoSnapshot();
              state.hasUndo = false;
              return render();
            }
            return;
          }
          if (a === "backup-snooze") {
            await put("settings", { ...state.settings, backupSnoozeUntil: new Date(Date.now() + 3 * 86400000).toISOString() });
            return load();
          }
          if (a === "export-activity-csv") return exportActivityCsv();
          if (a === "export-monthly-csv") return exportMonthlyCsv();
          if (a === "run-scenario") return runScenario();
          render();
        } catch (err) {
          showError(err);
        }
      }),
  );
  const pf = document.querySelector("#paycheck-form");
  if (pf)
    pf.onsubmit = (e) => {
      e.preventDefault();
      createPaycheck(pf).catch(showError);
    };
  const ef = document.querySelector("#expense-form");
  if (ef) {
    ef.onsubmit = (e) => {
      e.preventDefault();
      saveExpense(ef).catch(showError);
    };
    // Category tiles: highlight the chosen one and show what's left in it.
    const hint = ef.querySelector("#cat-hint");
    ef.querySelectorAll('input[name="category"]').forEach(
      (r) =>
        (r.onchange = () => {
          ef.querySelectorAll(".cat-tile").forEach((t) => t.classList.toggle("selected", !!t.querySelector("input")?.checked));
          if (hint) hint.textContent = r.dataset.hint || "";
        }),
    );
  }
  const inf = document.querySelector("#income-form");
  if (inf) {
    inf.onsubmit = (e) => {
      e.preventDefault();
      saveIncome(inf).catch(showError);
    };
    const it = inf.querySelector("#income-type"),
      tc = inf.querySelector("#income-tithe"),
      rc = inf.querySelector("#income-routing");
    if (it && !inf.querySelector("input[name=id]").value)
      it.onchange = () => {
        if (tc) tc.checked = ["regular_income", "bonus"].includes(it.value);
        if (rc) rc.checked = !["regular_income", "reimbursement"].includes(it.value);
      };
  }
  const irf = document.querySelector("#income-routing-form");
  if (irf)
    irf.onsubmit = (e) => {
      e.preventDefault();
      saveIncomeRouting(irf).catch(showError);
    };
  const mtf = document.querySelector("#manual-transfer-form");
  if (mtf)
    mtf.onsubmit = (e) => {
      e.preventDefault();
      try {
        prepareManualTransfer(mtf);
      } catch (err) {
        showError(err);
      }
    };
  const ctf = document.querySelector("#cash-transfer-form");
  if (ctf)
    ctf.onsubmit = (e) => {
      e.preventDefault();
      saveCashTransfer(ctf).catch(showError);
    };
  const prf = document.querySelector("#project-form");
  if (prf)
    prf.onsubmit = (e) => {
      e.preventDefault();
      saveProject(prf).catch(showError);
    };
  const pef = document.querySelector("#project-expense-form");
  if (pef)
    pef.onsubmit = (e) => {
      e.preventDefault();
      saveProjectExpense(pef).catch(showError);
    };
  const pdf = document.querySelector("#project-deposit-form");
  if (pdf)
    pdf.onsubmit = (e) => {
      e.preventDefault();
      saveProjectDeposit(pdf).catch(showError);
    };
  const psf = document.querySelector("#project-settlement-form");
  if (psf) {
    psf.onsubmit = (e) => {
      e.preventDefault();
      saveProjectSettlement(psf).catch(showError);
    };
    const inp = psf.querySelector("#project-reimbursement"),
      preview = psf.querySelector("#project-settlement-preview");
    if (inp && preview) {
      const total = projectKnownTwd(psf.dataset.project);
      const update = () => {
        const r = Number(inp.value);
        if (!Number.isFinite(r) || inp.value === "") {
          preview.innerHTML = "Enter the reimbursement amount to calculate the settlement difference.";
          return;
        }
        const d = r - total;
        preview.innerHTML =
          d > 0.5
            ? `<strong class="good">Surplus ${money(d)}</strong><br>Only this surplus enters your personal ledger.`
            : d < -0.5
              ? `<strong class="bad">Personal responsibility ${money(Math.abs(d))}</strong><br>Only this shortfall becomes a personal expense.`
              : `<strong class="good">Fully reimbursed</strong><br>No personal surplus or shortfall.`;
      };
      inp.oninput = update;
      update();
    }
  }
  const inv = document.querySelector("#investment-form");
  if (inv)
    inv.onsubmit = (e) => {
      e.preventDefault();
      saveInvestment(inv).catch(showError);
    };
  const arf = document.querySelector("#account-reconcile-form");
  if (arf)
    arf.onsubmit = (e) => {
      e.preventDefault();
      try {
        prepareAccountReconciliation(arf);
      } catch (err) {
        showError(err);
      }
    };
  const aaf = document.querySelector("#account-adjustment-form");
  if (aaf)
    aaf.onsubmit = (e) => {
      e.preventDefault();
      saveAccountAdjustment(aaf).catch(showError);
    };
  const eal = document.querySelector("#esun-allocation-form");
  if (eal)
    eal.onsubmit = (e) => {
      e.preventDefault();
      saveEsunAllocation(eal).catch(showError);
    };
  const erl = document.querySelector("#esun-reallocation-form");
  if (erl)
    erl.onsubmit = (e) => {
      e.preventDefault();
      saveEsunReallocation(erl).catch(showError);
    };
  const gef = document.querySelector("#goal-edit-form");
  if (gef)
    gef.onsubmit = (e) => {
      e.preventDefault();
      saveGoal(gef).catch(showError);
    };
  const gcf = document.querySelector("#goal-contribution-form");
  if (gcf)
    gcf.onsubmit = (e) => {
      e.preventDefault();
      saveGoalContribution(gcf).catch(showError);
    };
  const catf = document.querySelector("#category-form");
  if (catf)
    catf.onsubmit = (e) => {
      e.preventDefault();
      saveCategory(catf).catch(showError);
    };
  const fundf = document.querySelector("#fund-form");
  if (fundf)
    fundf.onsubmit = (e) => {
      e.preventDefault();
      saveFund(fundf).catch(showError);
    };
  const sf = document.querySelector("#settings-form");
  if (sf)
    sf.onsubmit = (e) => {
      e.preventDefault();
      saveSettings(sf).catch(showError);
    };
  const asf = document.querySelector("#activity-search-form");
  if (asf)
    asf.onsubmit = (e) => {
      e.preventDefault();
      activitySearch = document.querySelector("#activity-search-input")?.value || "";
      render();
    };
  const rf = document.querySelector("#restore-file");
  if (rf)
    rf.onchange = () => {
      if (rf.files[0]) restore(rf.files[0]).catch((err) => notify("Couldn't restore that backup", err.message || String(err)));
      rf.value = "";
    };
}

if ("serviceWorker" in navigator)
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
watchKeyboard();
// iOS only shows :active (the press-down feedback on buttons) once a touch listener exists on the page.
document.addEventListener("touchstart", () => {}, { passive: true });
load().catch((err) => {
  root.innerHTML = `<pre style="padding:20px">${esc(err.stack || err.message)}</pre>`;
});
