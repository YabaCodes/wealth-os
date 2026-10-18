// Special Budget settlement and undo persistence.
// All generated personal-ledger entries, settlement metadata and project status
// are written atomically. These helpers are shared by the UI and IDB tests.
import { atomicStoreUpdate } from "./db.js";
import { projectBudgetSummary, unresolvedDeposits } from "./special-budgets.js";
import {
  projectExpensesFor,
  projectKnownTwd as projectKnownTwdFromRows,
  projectMissingTwd as projectMissingTwdFromRows,
  projectPaymentTwd as projectPaymentTwdFromRows,
} from "./projects.js";

const SETTLEMENT_STORES = [
  "projects", "projectExpenses", "projectSettlements", "incomes",
  "expenses", "transfers", "transferAllocations", "periods",
];

const sortedRows = (rows) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
const sameRows = (a, b) => JSON.stringify(sortedRows(a)) === JSON.stringify(sortedRows(b));
const activeSettlement = (rows, id) => rows.find((s) => s.projectId === id && !s.deletedAt);

function assertProjectLinked(row, projectId, expectedId, name) {
  if (!row || row.id !== expectedId || row.sourceProjectId !== projectId)
    throw new Error("Invalid generated " + name + " record for this Special Budget.");
}

function assertOpenFundingPeriod(data, rows) {
  for (const row of rows.filter(Boolean)) {
    const id = row.budgetPeriodId;
    if (id && data.periods.find((p) => p.id === id)?.state === "closed")
      throw new Error("Funding month closed before settlement. Reopen it first.");
  }
}

/**
 * Commit a prepared settlement. The UI still computes the exact same records
 * and destination choices; this operation only changes how they reach storage.
 * Fresh IDB data is checked within the transaction to stop stale/duplicate saves.
 */
export async function commitSpecialBudgetSettlementAtomic({
  projectId, expectedExpenses, settlement, generatedIncome = null,
  generatedExpense = null, generatedTransfer = null, generatedAllocation = null,
}) {
  if (!projectId || !settlement || settlement.projectId !== projectId)
    throw new Error("Invalid Special Budget settlement.");
  if (settlement.generatedIncomeId !== (generatedIncome?.id || null) ||
      settlement.generatedExpenseId !== (generatedExpense?.id || null) ||
      settlement.generatedTransferId !== (generatedTransfer?.id || null))
    throw new Error("Settlement-linked records do not match.");
  if (generatedIncome) assertProjectLinked(generatedIncome, projectId, settlement.generatedIncomeId, "income");
  if (generatedExpense) assertProjectLinked(generatedExpense, projectId, settlement.generatedExpenseId, "expense");
  if (generatedTransfer) assertProjectLinked(generatedTransfer, projectId, settlement.generatedTransferId, "transfer");
  if (generatedAllocation && (!generatedTransfer || generatedAllocation.transferId !== generatedTransfer.id))
    throw new Error("Settlement allocation is not linked to its transfer.");

  await atomicStoreUpdate(SETTLEMENT_STORES, (data, store) => {
    const current = data.projects.find((p) => p.id === projectId && !p.deletedAt);
    if (!current) throw new Error("Special Budget no longer exists.");
    if (current.status === "settled" || activeSettlement(data.projectSettlements, projectId))
      throw new Error("Special Budget is already settled.");

    const expenses = projectExpensesFor(data.projectExpenses, projectId);
    if (!sameRows(expenses, expectedExpenses || []))
      throw new Error("Special Budget entries changed. Reopen the settlement preview.");
    const pending = unresolvedDeposits(expenses);
    if (pending.length) throw new Error("Resolve refundable deposits before settling.");
    if (projectMissingTwdFromRows(data.projectExpenses, projectId).length)
      throw new Error("Enter all exact NTD expense amounts before settling.");

    const summary = projectBudgetSummary(current, expenses);
    const total = Math.round(projectKnownTwdFromRows(data.projectExpenses, projectId));
    const card = Math.round(projectPaymentTwdFromRows(data.projectExpenses, projectId, "esun_card"));
    if (total !== Number(settlement.totalProjectCostTwd) ||
        card !== Number(settlement.cardPaidTwd) ||
        Number(settlement.differenceTwd) !== Number(settlement.reimbursementTwd) - total ||
        (current.type === "business_trip" &&
          (Number(settlement.expectedReimbursementTwd) !== Math.round(summary.expectedReimbursement) ||
           Number(settlement.exactReimbursableTwd) !== Math.round(summary.exact) ||
           Number(settlement.flexibleAllowanceTwd) !== Math.round(summary.allowance) ||
           Number(settlement.flexibleSpentTwd) !== Math.round(summary.flexible))))
      throw new Error("Settlement totals changed. Reopen the settlement preview.");

    assertOpenFundingPeriod(data, [generatedIncome, generatedExpense, generatedTransfer]);
    // Fail rather than overwriting an unrelated id on a rare generated-id collision.
    for (const [name, row] of [
      ["incomes", generatedIncome],
      ["expenses", generatedExpense],
      ["transfers", generatedTransfer],
      ["transferAllocations", generatedAllocation],
      ["projectSettlements", settlement],
    ]) {
      if (row && data[name].some((existing) => existing.id === row.id))
        throw new Error("Generated settlement identifier already exists.");
    }

    if (generatedIncome) store("incomes").put(generatedIncome);
    if (generatedExpense) store("expenses").put(generatedExpense);
    if (generatedTransfer) store("transfers").put(generatedTransfer);
    if (generatedAllocation) store("transferAllocations").put(generatedAllocation);
    store("projectSettlements").put(settlement);
    store("projects").put({
      ...current, status: "settled", settledAt: settlement.createdAt,
      updatedAt: settlement.updatedAt,
    });
  });
}

/**
 * Undo generated records as one atomic unit. If the surplus transfer was
 * completed, the entire transaction is rejected without deleting anything.
 */
export async function undoSpecialBudgetSettlementAtomic(projectId, stamp) {
  if (!projectId) throw new Error("Missing Special Budget ID.");
  await atomicStoreUpdate(SETTLEMENT_STORES, (data, store) => {
    const project = data.projects.find((p) => p.id === projectId && !p.deletedAt);
    const settlement = activeSettlement(data.projectSettlements, projectId);
    if (!project || !settlement) throw new Error("No active Special Budget settlement to undo.");
    const generatedTransfer = settlement.generatedTransferId
      ? data.transfers.find((t) => t.id === settlement.generatedTransferId && !t.deletedAt)
      : null;
    if (generatedTransfer?.status === "completed")
      throw new Error(
        "The surplus transfer is already completed. Reverse that real bank movement manually before undoing the settlement.",
      );
    if (generatedTransfer) {
      assertProjectLinked(generatedTransfer, projectId, settlement.generatedTransferId, "transfer");
      for (const allocation of data.transferAllocations.filter((a) => a.transferId === generatedTransfer.id))
        store("transferAllocations").delete(allocation.id);
      store("transfers").delete(generatedTransfer.id);
    }
    if (settlement.generatedIncomeId) {
      const income = data.incomes.find((r) => r.id === settlement.generatedIncomeId);
      if (income) {
        assertProjectLinked(income, projectId, settlement.generatedIncomeId, "income");
        store("incomes").delete(income.id);
      }
    }
    if (settlement.generatedExpenseId) {
      const expense = data.expenses.find((r) => r.id === settlement.generatedExpenseId);
      if (expense) {
        assertProjectLinked(expense, projectId, settlement.generatedExpenseId, "expense");
        store("expenses").delete(expense.id);
      }
    }
    store("projectSettlements").delete(settlement.id);
    store("projects").put({ ...project, status: "active", settledAt: null, updatedAt: stamp });
  });
}
